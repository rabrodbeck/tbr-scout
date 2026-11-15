import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { analyzeTasteProfile } from "@/services/taste/taste-analyzer";
import { generateTasteVector } from "@/services/taste/embedding-generator";
import { NormalizedBook } from "@/services/parser/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // 1. Authenticate user session
    const serverClient = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await serverClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "You must be signed in to recalculate your Reading DNA." },
        { status: 401 }
      );
    }

    // 2. Rate-limiting protection (max 5 recalculations per 3 minutes per user)
    const clientIp = getClientIp(req);
    const rateLimitKey = `dna-recalc:${user.id}:${clientIp}`;
    const rateLimit = checkRateLimit(rateLimitKey, {
      maxRequests: 5,
      windowMs: 3 * 60 * 1000,
    });

    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too many recalculation requests. Please wait a couple minutes before trying again.",
          retryAfter: rateLimit.reset,
        },
        { status: 429 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const adminSupabase = createAdminClient(supabaseUrl, supabaseKey);

    // 3. Query all user books joined with catalog books
    const { data: rawUserBooks, error: booksError } = await adminSupabase
      .from("user_books")
      .select(`
        id,
        book_id,
        shelf,
        rating,
        date_read,
        user_review,
        user_shelves,
        created_at,
        books (
          id,
          title,
          author,
          cover_url,
          published_year,
          page_count,
          isbn,
          isbn13
        )
      `)
      .eq("user_id", user.id);

    if (booksError) {
      console.error("Failed to query user books for DNA recalculation:", booksError);
      return NextResponse.json(
        { error: "Failed to retrieve your library books." },
        { status: 500 }
      );
    }

    if (!rawUserBooks || rawUserBooks.length === 0) {
      return NextResponse.json(
        {
          error: "No books found in your library. Add books or Lifetime Reads first to calculate your Reading DNA.",
        },
        { status: 400 }
      );
    }

    if (rawUserBooks.length < 3) {
      return NextResponse.json(
        {
          error: "Add at least 3 books to your library to calculate a personalized Reading DNA.",
        },
        { status: 400 }
      );
    }

    // 4. Map user books into NormalizedBook format for high-signal taste analysis
    const normalizedBooks: NormalizedBook[] = rawUserBooks.map((ub: any) => {
      const bookData = ub.books || {};
      const title = bookData.title || "Untitled";
      return {
        goodreadsId: ub.book_id || ub.id,
        title,
        cleanTitle: title,
        series: null,
        author: bookData.author || "Unknown Author",
        additionalAuthors: [],
        isbn: bookData.isbn || null,
        isbn13: bookData.isbn13 || null,
        myRating: typeof ub.rating === "number" ? ub.rating : 0,
        averageRating: 0,
        publisher: null,
        binding: null,
        pageCount: bookData.page_count || null,
        yearPublished: bookData.published_year || null,
        originalPublicationYear: null,
        dateRead: ub.date_read || null,
        dateAdded: ub.created_at || null,
        shelf: (ub.shelf as any) || "read",
        userShelves: Array.isArray(ub.user_shelves) ? ub.user_shelves : [],
        userReview: ub.user_review || null,
        readCount: ub.shelf === "read" ? 1 : 0,
      };
    });

    // 5. Synthesize updated taste archetype via Gemini 2.5 Flash
    const tasteProfile = await analyzeTasteProfile(normalizedBooks);

    // 6. Generate 768-dim vector embedding via Google embedding model
    let tasteVector: number[] | null = null;
    try {
      tasteVector = await generateTasteVector(tasteProfile);
    } catch (embedErr) {
      console.warn("Failed to generate vector embedding during recalculation:", embedErr);
    }

    const updatedAt = new Date().toISOString();

    // 7. Upsert updated taste profile
    const { error: tasteError } = await adminSupabase
      .from("taste_profiles")
      .upsert(
        {
          user_id: user.id,
          archetype_name: tasteProfile.archetype_name,
          archetype_summary: tasteProfile.archetype_summary,
          preferred_pacing: tasteProfile.preferred_pacing,
          emotional_tone: tasteProfile.emotional_tone,
          top_tropes: tasteProfile.top_tropes,
          dealbreakers: tasteProfile.dealbreakers,
          ...(tasteVector ? { taste_vector: tasteVector } : {}),
          updated_at: updatedAt,
        },
        { onConflict: "user_id" }
      );

    if (tasteError) {
      console.error("Failed to upsert updated taste profile:", tasteError);
      return NextResponse.json(
        { error: "Failed to persist updated taste profile." },
        { status: 500 }
      );
    }

    // 8. Update user's profile taste archetype badge
    const { error: profileError } = await adminSupabase
      .from("profiles")
      .update({
        taste_archetype: tasteProfile.archetype_name,
        updated_at: updatedAt,
      })
      .eq("id", user.id);

    if (profileError) {
      console.warn("Failed to update profile archetype name:", profileError);
    }

    return NextResponse.json({
      success: true,
      message: "Reading DNA recalculated successfully from your library.",
      tasteProfile: {
        user_id: user.id,
        archetype_name: tasteProfile.archetype_name,
        archetype_summary: tasteProfile.archetype_summary,
        preferred_pacing: tasteProfile.preferred_pacing,
        emotional_tone: tasteProfile.emotional_tone,
        top_tropes: tasteProfile.top_tropes,
        dealbreakers: tasteProfile.dealbreakers,
        updated_at: updatedAt,
      },
    });
  } catch (err: any) {
    console.error("Recalculate Reading DNA error:", err);
    return NextResponse.json(
      { error: err?.message || "An unexpected error occurred while recalculating your Reading DNA." },
      { status: 500 }
    );
  }
}

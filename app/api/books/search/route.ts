import { NextRequest, NextResponse } from "next/server";
import {
  isBadCoverUrl,
  isStudyGuideOrJunk,
  isbn13To10,
} from "@/services/books/cover-service";

export const dynamic = "force-dynamic";

export interface SearchResultItem {
  key: string;
  title: string;
  author: string;
  cover_url: string | null;
  published_year: number | null;
  page_count: number | null;
  isbn: string | null;
  isbn13: string | null;
  genres: string[];
  snippet: string | null;
}

/**
 * Normalizes title string for deduplication comparison
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Searches Google Books Volumes API as a robust secondary provider
 */
export async function searchGoogleBooks(query: string): Promise<SearchResultItem[]> {
  try {
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
    const keyParam = apiKey ? `&key=${apiKey}` : "";
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
      query
    )}&maxResults=10&printType=books${keyParam}`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];

    const results: SearchResultItem[] = [];

    for (const item of items) {
      const vi = item.volumeInfo || {};
      const title = vi.title?.trim() || "Untitled";
      const author = Array.isArray(vi.authors)
        ? vi.authors[0]
        : (vi.authors || "Unknown Author");

      // Filter out study guides, sparknotes, and box sets
      if (isStudyGuideOrJunk(title, author)) {
        continue;
      }

      const industryIds = Array.isArray(vi.industryIdentifiers)
        ? vi.industryIdentifiers
        : [];
      const isbn13Obj = industryIds.find((id: any) => id.type === "ISBN_13");
      const isbn10Obj = industryIds.find((id: any) => id.type === "ISBN_10");
      const isbn13 = isbn13Obj?.identifier || null;
      const isbn10 = isbn10Obj?.identifier || null;

      // Extract cover image
      let coverUrl: string | null = null;
      if (
        vi.imageLinks?.extraLarge ||
        vi.imageLinks?.large ||
        vi.imageLinks?.medium ||
        vi.imageLinks?.thumbnail
      ) {
        const raw =
          vi.imageLinks.extraLarge ||
          vi.imageLinks.large ||
          vi.imageLinks.medium ||
          vi.imageLinks.thumbnail;
        coverUrl = raw.replace(/^http:\/\//i, "https://");
      }

      // If Google image is missing, attempt Amazon CDN ISBN-10
      if (!coverUrl) {
        const resolvedIsbn10 = isbn10 || (isbn13 ? isbn13To10(isbn13) : null);
        if (resolvedIsbn10 && resolvedIsbn10.length === 10) {
          coverUrl = `https://images-na.ssl-images-amazon.com/images/P/${resolvedIsbn10}.01.LZZZZZZZ.jpg`;
        }
      }

      if (isBadCoverUrl(coverUrl)) {
        coverUrl = null;
      }

      const publishedYear = vi.publishedDate
        ? parseInt(vi.publishedDate.substring(0, 4), 10) || null
        : null;

      results.push({
        key: item.id ? `/google/${item.id}` : `gb-${results.length}`,
        title,
        author,
        cover_url: coverUrl,
        published_year: publishedYear,
        page_count: vi.pageCount || null,
        isbn: isbn10,
        isbn13: isbn13,
        genres: Array.isArray(vi.categories) ? vi.categories.slice(0, 5) : [],
        snippet: vi.description ? vi.description.slice(0, 220) + "..." : null,
      });
    }

    return results;
  } catch (err) {
    console.warn("Google Books search fallback failed:", err);
    return [];
  }
}

/**
 * Parses Goodreads HTML (JSON-LD, og:tags, genres) into a normalized SearchResultItem
 */
export function parseGoodreadsHtml(
  html: string,
  fallbackKey?: string,
  fallbackIsbn?: string
): SearchResultItem | null {
  const jsonLdMatch = html.match(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i);
  let ld: any = null;
  if (jsonLdMatch) {
    try {
      ld = JSON.parse(jsonLdMatch[1]);
    } catch {
      ld = null;
    }
  }

  const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
  const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);

  let title = (ld?.name || ogTitleMatch?.[1] || "").trim();
  if (!title) return null;

  // Clean trailing " by Author"
  title = title.replace(/\s+by\s+[^]+$/i, "").trim();

  let author = "Unknown Author";
  if (Array.isArray(ld?.author) && ld.author[0]?.name) {
    author = ld.author[0].name.trim();
  } else if (ld?.author?.name) {
    author = ld.author.name.trim();
  } else {
    const authorMatch = html.match(/class=["']authorName["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (authorMatch?.[1]) author = authorMatch[1].trim();
  }

  if (isStudyGuideOrJunk(title, author)) return null;

  let coverUrl = ld?.image || ogImageMatch?.[1] || null;
  if (coverUrl) {
    coverUrl = coverUrl.replace(/\._S[XY]\d+_/, "");
    if (isBadCoverUrl(coverUrl)) coverUrl = null;
  }

  const isbnRaw = ld?.isbn ? String(ld.isbn).replace(/[^0-9X]/gi, "") : (fallbackIsbn || null);
  let isbn10: string | null = null;
  let isbn13: string | null = null;

  if (isbnRaw) {
    if (isbnRaw.length === 10) {
      isbn10 = isbnRaw;
    } else if (isbnRaw.length === 13) {
      isbn13 = isbnRaw;
      isbn10 = isbn13To10(isbnRaw);
    }
  }

  if (!coverUrl && isbn10) {
    coverUrl = `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.LZZZZZZZ.jpg`;
  }

  let publishedYear: number | null = null;
  const pubMatch = html.match(/published[\s\S]*?\b(19\d\d|20\d\d)\b/i) || html.match(/\b(19\d\d|20\d\d)\b/);
  if (pubMatch) {
    publishedYear = parseInt(pubMatch[1], 10);
  }

  const genreMatches = [...html.matchAll(/\/genres\/([a-zA-Z\-]+)/gi)];
  const genres = [...new Set(genreMatches.map((m) => {
    const raw = m[1].replace(/-/g, " ");
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }))].slice(0, 5);

  const pageCount = typeof ld?.numberOfPages === "number" ? ld.numberOfPages : null;
  const snippet = ogDescMatch?.[1] ? ogDescMatch[1].trim() : null;

  return {
    key: fallbackKey || `/goodreads/${isbnRaw || normalizeTitle(title).replace(/\s+/g, "-")}`,
    title,
    author,
    cover_url: coverUrl,
    published_year: publishedYear,
    page_count: pageCount,
    isbn: isbn10,
    isbn13: isbn13,
    genres,
    snippet,
  };
}

/**
 * Attempts high-speed direct Goodreads lookup by ISBN
 */
export async function fetchGoodreadsIsbn(cleanIsbn: string): Promise<SearchResultItem | null> {
  const url = `https://www.goodreads.com/book/isbn/${cleanIsbn}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const html = await res.text();
      return parseGoodreadsHtml(html, `/isbn/${cleanIsbn}`, cleanIsbn);
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * Searches Gemini with Google Search grounding for verified real-time bibliographic data.
 * Ideal for new releases, unindexed books, and queries that return 0 results from Open Library.
 */
export async function searchGeminiBooks(query: string): Promise<SearchResultItem[]> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return [];

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const prompt = `Search Google and return bibliographic details for: "${query}".
Return ONLY a valid JSON array of up to 5 matching real books in this exact format:
[
  {
    "title": "Exact Title of Book",
    "author": "Author Name",
    "published_year": 2026,
    "isbn10": "039959146X",
    "isbn13": "9780399591464",
    "page_count": 416,
    "genres": ["Thriller", "Suspense"],
    "description": "Short synopsis"
  }
]`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("\n") || "";

    const jsonMatch = text.match(/\[[\s\S]*\]/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    let parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }

    const results: SearchResultItem[] = [];

    for (const b of parsed) {
      if (!b.title || !b.author || isStudyGuideOrJunk(b.title, b.author)) continue;

      const raw10 = b.isbn10 ? String(b.isbn10).replace(/[^0-9X]/gi, "") : null;
      const raw13 = b.isbn13 ? String(b.isbn13).replace(/[^0-9]/g, "") : null;
      const isbn10 = raw10 && raw10.length === 10 ? raw10 : (raw13 ? isbn13To10(raw13) : null);
      const isbn13 = raw13 && raw13.length === 13 ? raw13 : null;

      let coverUrl: string | null = null;
      if (isbn10 && isbn10.length === 10) {
        coverUrl = `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.LZZZZZZZ.jpg`;
      }
      if (isBadCoverUrl(coverUrl)) coverUrl = null;

      results.push({
        key: `/gemini/${isbn13 || isbn10 || normalizeTitle(b.title).replace(/\s+/g, "-")}`,
        title: b.title.trim(),
        author: b.author.trim(),
        cover_url: coverUrl,
        published_year: typeof b.published_year === "number" ? b.published_year : null,
        page_count: typeof b.page_count === "number" ? b.page_count : null,
        isbn: isbn10,
        isbn13: isbn13,
        genres: Array.isArray(b.genres) ? b.genres.slice(0, 5) : [],
        snippet: b.description ? String(b.description).slice(0, 260) : null,
      });
    }

    return results;
  } catch (err) {
    console.warn("Gemini search grounding fallback failed:", err);
    return [];
  }
}

/**
 * Direct Gemini + Google Search Grounding ISBN lookup
 */
export async function fetchGeminiIsbn(cleanIsbn: string): Promise<SearchResultItem | null> {
  const results = await searchGeminiBooks(`ISBN ${cleanIsbn}`);
  return results.length > 0 ? results[0] : null;
}

interface CachedBookResult {
  timestamp: number;
  results: SearchResultItem[];
}

// In-memory ISBN lookup cache (24hr TTL) for instant sub-millisecond responses
export const isbnCache = new Map<string, CachedBookResult>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

export function clearIsbnCache() {
  isbnCache.clear();
}

/**
 * High-speed direct Open Library Books API query by ISBN (jscmd=data)
 */
export async function fetchOpenLibraryIsbn(cleanIsbn: string): Promise<SearchResultItem | null> {
  try {
    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TBRScout/1.0 (contact@tbrscout.vercel.app)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const book = data[`ISBN:${cleanIsbn}`];
    if (!book || !book.title) return null;

    const title = book.title.trim();
    const author = Array.isArray(book.authors) && book.authors[0]?.name
      ? book.authors[0].name.trim()
      : "Unknown Author";

    if (isStudyGuideOrJunk(title, author)) return null;

    let coverUrl: string | null = null;
    if (book.cover?.large) coverUrl = book.cover.large;
    else if (book.cover?.medium) coverUrl = book.cover.medium;
    else if (book.cover?.small) coverUrl = book.cover.small;

    const isbn10 = cleanIsbn.length === 10 ? cleanIsbn : isbn13To10(cleanIsbn);
    if (!coverUrl && isbn10) {
      coverUrl = `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.LZZZZZZZ.jpg`;
    }

    if (isBadCoverUrl(coverUrl)) coverUrl = null;

    let publishedYear: number | null = null;
    if (book.publish_date) {
      const match = String(book.publish_date).match(/\b(19\d\d|20\d\d)\b/);
      if (match) publishedYear = parseInt(match[1], 10);
    }

    const genres: string[] = Array.isArray(book.subjects)
      ? book.subjects.map((s: any) => (typeof s === "string" ? s : s.name)).filter(Boolean).slice(0, 5)
      : [];

    return {
      key: book.key || `/isbn/${cleanIsbn}`,
      title,
      author,
      cover_url: coverUrl,
      published_year: publishedYear,
      page_count: typeof book.number_of_pages === "number" ? book.number_of_pages : null,
      isbn: isbn10 || cleanIsbn,
      isbn13: cleanIsbn.length === 13 ? cleanIsbn : null,
      genres,
      snippet: typeof book.notes === "string" ? book.notes : null,
    };
  } catch {
    return null;
  }
}

/**
 * High-speed direct Google Books query by ISBN
 */
export async function fetchGoogleBooksIsbn(cleanIsbn: string): Promise<SearchResultItem | null> {
  try {
    const results = await searchGoogleBooks(`isbn:${cleanIsbn}`);
    return results.length > 0 ? results[0] : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q")?.trim();
    const workKey = searchParams.get("work")?.trim();

    // 1. If fetching full description for a specific work key
    if (workKey) {
      const cleanWork = workKey.startsWith("/works/") ? workKey : `/works/${workKey}`;
      try {
        const workRes = await fetch(`https://openlibrary.org${cleanWork}.json`, {
          headers: { "User-Agent": "TBRScout/1.0" },
          signal: AbortSignal.timeout(6000),
        });
        if (workRes.ok) {
          const workData = await workRes.json();
          let description: string | null = null;
          if (typeof workData.description === "string") {
            description = workData.description;
          } else if (workData.description && typeof workData.description.value === "string") {
            description = workData.description.value;
          }
          return NextResponse.json({ description });
        }
      } catch (err) {
        console.warn("Failed to fetch work description:", err);
      }
      return NextResponse.json({ description: null });
    }

    // 2. Query search
    if (!query || query.length < 2) {
      return NextResponse.json({ results: [], hasMore: false, page: 1, total: 0 });
    }

    const pageParam = searchParams.get("page");
    const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(50, Math.max(5, parseInt(limitParam, 10))) : 20;

    // FAST-PATH: If query is an ISBN (10 or 13 digits), execute direct parallel lookup
    const cleanIsbn = query.replace(/[-\s]/g, "").trim();
    const isIsbn = /^\d{9}[\dX]$/i.test(cleanIsbn) || /^\d{13}$/.test(cleanIsbn);

    if (isIsbn) {
      // 1. Instant In-Memory Cache (0ms)
      const cached = isbnCache.get(cleanIsbn);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return NextResponse.json(
          { results: cached.results, hasMore: false, page: 1, total: cached.results.length },
          { headers: { "Cache-Control": "public, s-maxage=604800, stale-while-revalidate=86400" } }
        );
      }

      // 2. Parallel Provider Race (Open Library Direct Books API + Google Books + Goodreads)
      const [olMatch, gbMatch, grMatch] = await Promise.all([
        fetchOpenLibraryIsbn(cleanIsbn),
        fetchGoogleBooksIsbn(cleanIsbn),
        fetchGoodreadsIsbn(cleanIsbn),
      ]);

      let primary = olMatch || gbMatch || grMatch;

      // 3. Fallback to Gemini with Google Search Grounding for new releases or unindexed ISBNs
      if (!primary) {
        primary = await fetchGeminiIsbn(cleanIsbn);
      }

      if (primary) {
        const results = [primary];
        for (const alt of [gbMatch, grMatch]) {
          if (alt && alt.title.toLowerCase() !== primary.title.toLowerCase()) {
            results.push(alt);
          }
        }
        isbnCache.set(cleanIsbn, { timestamp: Date.now(), results });
        return NextResponse.json(
          { results, hasMore: false, page: 1, total: results.length },
          { headers: { "Cache-Control": "public, s-maxage=604800, stale-while-revalidate=86400" } }
        );
      }
    }

    let olResults: SearchResultItem[] = [];
    let totalFound = 0;

    // Attempt primary search via Open Library
    try {
      const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(
        query
      )}&page=${page}&limit=${limit}&fields=key,title,author_name,cover_i,first_publish_year,number_of_pages_median,isbn,subject,first_sentence,language,editions`;

      const res = await fetch(searchUrl, {
        headers: { "User-Agent": "TBRScout/1.0 (contact@tbrscout.vercel.app)" },
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data = await res.json();
        if (typeof data.numFound === "number") {
          totalFound = data.numFound;
        }
        const docs = Array.isArray(data.docs) ? data.docs : [];

        for (const doc of docs) {
          const title = doc.title || "Untitled";
          const author = Array.isArray(doc.author_name)
            ? doc.author_name[0]
            : (doc.author_name || "Unknown Author");

          // Reject study guides, SuperSummary, and box sets
          if (isStudyGuideOrJunk(title, author)) {
            continue;
          }

          // 1. Cover URL resolution: prioritize cover_i, then child editions
          let coverUrl: string | null = null;
          if (doc.cover_i) {
            coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
          } else if (doc.editions?.docs && Array.isArray(doc.editions.docs)) {
            const engEdition = doc.editions.docs.find(
              (e: any) => e.cover_i && (e.language?.includes("eng") || e.language?.includes("en"))
            );
            const editionCover = engEdition?.cover_i || doc.editions.docs[0]?.cover_i;
            if (editionCover) {
              coverUrl = `https://covers.openlibrary.org/b/id/${editionCover}-L.jpg`;
            }
          }

          // 2. ISBN resolution
          const isbns: string[] = Array.isArray(doc.isbn) ? doc.isbn : [];
          const isbn13 = isbns.find((i) => i.replace(/-/g, "").length === 13) || null;
          const isbn10 = isbns.find((i) => i.replace(/-/g, "").length === 10) || isbns[0] || null;

          // 3. Amazon ISBN CDN fallback if Open Library cover is missing
          if (!coverUrl) {
            const resolvedIsbn10 = isbn10 || (isbn13 ? isbn13To10(isbn13) : null);
            if (resolvedIsbn10 && resolvedIsbn10.length === 10) {
              coverUrl = `https://images-na.ssl-images-amazon.com/images/P/${resolvedIsbn10}.01.LZZZZZZZ.jpg`;
            }
          }

          // Reject known bad or placeholder covers
          if (isBadCoverUrl(coverUrl)) {
            coverUrl = null;
          }

          // 4. First sentence / snippet preview
          let snippet: string | null = null;
          if (Array.isArray(doc.first_sentence) && doc.first_sentence.length > 0) {
            snippet = doc.first_sentence[0];
          } else if (typeof doc.first_sentence === "string") {
            snippet = doc.first_sentence;
          }

          olResults.push({
            key: doc.key || "",
            title,
            author,
            cover_url: coverUrl,
            published_year: doc.first_publish_year || null,
            page_count: doc.number_of_pages_median || null,
            isbn: isbn10,
            isbn13: isbn13,
            genres: Array.isArray(doc.subject) ? doc.subject.slice(0, 5) : [],
            snippet,
          });
        }
      }
    } catch (olError) {
      console.warn("Open Library search request failed, falling back to secondary providers:", olError);
    }

    // If query has a subtitle (e.g. "You First: A Joe Goldberg Prequel"), also try searching by primary title
    if (olResults.length < 3 && /[:\-]/.test(query)) {
      const primaryTitle = query.split(/[:\-]/)[0].trim();
      if (primaryTitle.length >= 2 && primaryTitle.toLowerCase() !== query.toLowerCase()) {
        try {
          const subUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(
            primaryTitle
          )}&page=1&limit=10&fields=key,title,author_name,cover_i,first_publish_year,number_of_pages_median,isbn,subject,first_sentence,language,editions`;

          const subRes = await fetch(subUrl, {
            headers: { "User-Agent": "TBRScout/1.0 (contact@tbrscout.vercel.app)" },
            signal: AbortSignal.timeout(5000),
          });

          if (subRes.ok) {
            const subData = await subRes.json();
            const docs = Array.isArray(subData.docs) ? subData.docs : [];
            const existingKeys = new Set(olResults.map((r) => normalizeTitle(r.title)));

            for (const doc of docs) {
              const title = doc.title || "Untitled";
              const author = Array.isArray(doc.author_name)
                ? doc.author_name[0]
                : (doc.author_name || "Unknown Author");

              if (isStudyGuideOrJunk(title, author)) continue;
              if (existingKeys.has(normalizeTitle(title))) continue;

              const isbns: string[] = Array.isArray(doc.isbn) ? doc.isbn : [];
              const isbn13 = isbns.find((i) => i.replace(/-/g, "").length === 13) || null;
              const isbn10 = isbns.find((i) => i.replace(/-/g, "").length === 10) || isbns[0] || null;

              let coverUrl = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null;
              if (!coverUrl) {
                const resolvedIsbn10 = isbn10 || (isbn13 ? isbn13To10(isbn13) : null);
                if (resolvedIsbn10 && resolvedIsbn10.length === 10) {
                  coverUrl = `https://images-na.ssl-images-amazon.com/images/P/${resolvedIsbn10}.01.LZZZZZZZ.jpg`;
                }
              }

              existingKeys.add(normalizeTitle(title));
              olResults.push({
                key: doc.key || "",
                title,
                author,
                cover_url: coverUrl,
                published_year: doc.first_publish_year || null,
                page_count: doc.number_of_pages_median || null,
                isbn: isbn10,
                isbn13: isbn13,
                genres: Array.isArray(doc.subject) ? doc.subject.slice(0, 5) : [],
                snippet: null,
              });
            }
          }
        } catch {
          // Non-fatal
        }
      }
    }

    // Check if query matches an author bibliography (multiple books by the author in olResults)
    const normQuery = normalizeTitle(query);
    const isAuthorQuery =
      olResults.filter(
        (r) =>
          normalizeTitle(r.author).includes(normQuery) ||
          normQuery.includes(normalizeTitle(r.author))
      ).length >= 2;

    // Check if we already have an authentic exact title match (ignoring placeholders like "Untitled <Author>")
    const hasExactTitleMatch = olResults.some((r) => {
      const normTitle = normalizeTitle(r.title);
      if (normTitle.startsWith("untitled")) return false;
      return normTitle.includes(normQuery) || normQuery.includes(normTitle);
    });

    // If Open Library yielded fewer than 5 results, OR this is an author search (to include unindexed new releases),
    // OR missing exact title match, supplement with Google Books and Gemini Google Search Grounding
    if (olResults.length < 5 || isAuthorQuery || !hasExactTitleMatch) {
      const [gbResults, geminiResults] = await Promise.all([
        searchGoogleBooks(query),
        searchGeminiBooks(query),
      ]);

      const existingKeys = new Set(olResults.map((r) => normalizeTitle(r.title)));

      for (const item of [...geminiResults, ...gbResults]) {
        const norm = normalizeTitle(item.title);
        if (!existingKeys.has(norm)) {
          existingKeys.add(norm);
          // If this is an exact title match or a new release for author searches, prioritize at the front
          if (
            norm.includes(normQuery) ||
            normQuery.includes(norm) ||
            (isAuthorQuery && item.published_year && item.published_year >= 2024)
          ) {
            olResults.unshift(item);
          } else {
            olResults.push(item);
          }
        }
      }
    }

    const hasMore = totalFound > page * limit;

    return NextResponse.json({
      results: olResults,
      hasMore,
      page,
      total: totalFound || olResults.length,
    });
  } catch (error: any) {
    console.error("Multi-Provider Book Search Error:", error);
    return NextResponse.json(
      { error: error?.message || "Search failed", results: [] },
      { status: 500 }
    );
  }
}

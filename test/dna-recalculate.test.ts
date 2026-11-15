import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/dna/recalculate/route";

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockAnalyzeTasteProfile = vi.fn();
const mockGenerateTasteVector = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

vi.mock("@/services/taste/taste-analyzer", () => ({
  analyzeTasteProfile: vi.fn((books) => mockAnalyzeTasteProfile(books)),
}));

vi.mock("@/services/taste/embedding-generator", () => ({
  generateTasteVector: vi.fn((profile) => mockGenerateTasteVector(profile)),
}));

describe("POST /api/dna/recalculate (Issue #76)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 Unauthorized when user is not signed in", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("Not signed in") });

    const req = new Request("http://localhost:3000/api/dna/recalculate", {
      method: "POST",
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toContain("must be signed in");
  });

  it("returns 400 Bad Request when user has 0 books in library", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    });

    const req = new Request("http://localhost:3000/api/dna/recalculate", {
      method: "POST",
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("No books found");
  });

  it("returns 400 Bad Request when user has fewer than 3 books in library", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });

    const mockBooks = [
      {
        id: "ub-1",
        book_id: "b-1",
        shelf: "read",
        rating: 5,
        books: { title: "Dune", author: "Frank Herbert" },
      },
      {
        id: "ub-2",
        book_id: "b-2",
        shelf: "read",
        rating: 4,
        books: { title: "Project Hail Mary", author: "Andy Weir" },
      },
    ];

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: mockBooks, error: null }),
      }),
    });

    const req = new Request("http://localhost:3000/api/dna/recalculate", {
      method: "POST",
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("at least 3 books");
  });

  it("successfully recalculates taste archetype and vector embeddings, updating database", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });

    const mockBooks = [
      {
        id: "ub-1",
        book_id: "b-1",
        shelf: "read",
        rating: 5,
        books: { title: "Dune", author: "Frank Herbert", page_count: 500, published_year: 1965 },
      },
      {
        id: "ub-2",
        book_id: "b-2",
        shelf: "read",
        rating: 5,
        books: { title: "Project Hail Mary", author: "Andy Weir", page_count: 496, published_year: 2021 },
      },
      {
        id: "ub-3",
        book_id: "b-3",
        shelf: "read",
        rating: 4,
        books: { title: "Dark Matter", author: "Blake Crouch", page_count: 342, published_year: 2016 },
      },
    ];

    const mockTasteProfile = {
      archetype_name: "The Sci-Fi High-Concept Explorer",
      archetype_summary: "You crave cerebral, high-stakes narratives anchored in scientific wonder.",
      preferred_pacing: "Fast & Kinetic",
      emotional_tone: "Tense & Thought-Provoking",
      top_tropes: ["First Contact", "Space Survival", "Multiverse"],
      dealbreakers: ["Aimless Pacing", "Love Triangles"],
    };

    const mockTasteVector = new Array(768).fill(0.05);

    mockAnalyzeTasteProfile.mockResolvedValueOnce(mockTasteProfile);
    mockGenerateTasteVector.mockResolvedValueOnce(mockTasteVector);

    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === "user_books") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: mockBooks, error: null }),
          }),
        };
      }
      if (table === "taste_profiles") {
        return {
          upsert: mockUpsert,
        };
      }
      if (table === "profiles") {
        return {
          update: mockUpdate,
        };
      }
      return {};
    });

    const req = new Request("http://localhost:3000/api/dna/recalculate", {
      method: "POST",
      headers: { "x-forwarded-for": "192.168.1.100" },
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.tasteProfile.archetype_name).toBe("The Sci-Fi High-Concept Explorer");
    expect(json.tasteProfile.preferred_pacing).toBe("Fast & Kinetic");

    // Verify analyzeTasteProfile received normalized books
    expect(mockAnalyzeTasteProfile).toHaveBeenCalledTimes(1);
    const passedBooks = mockAnalyzeTasteProfile.mock.calls[0][0];
    expect(passedBooks.length).toBe(3);
    expect(passedBooks[0].cleanTitle).toBe("Dune");

    // Verify taste_profiles upsert was called with vector
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-123",
        archetype_name: "The Sci-Fi High-Concept Explorer",
        taste_vector: mockTasteVector,
      }),
      { onConflict: "user_id" }
    );

    // Verify profiles table updated with archetype name
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        taste_archetype: "The Sci-Fi High-Concept Explorer",
      })
    );
  });

  it("enforces rate-limiting when recalculate is requested more than 5 times in window", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "rate-limited-user" } }, error: null });

    const mockBooks = [
      { id: "1", shelf: "read", rating: 5, books: { title: "A", author: "A" } },
      { id: "2", shelf: "read", rating: 5, books: { title: "B", author: "B" } },
      { id: "3", shelf: "read", rating: 5, books: { title: "C", author: "C" } },
    ];

    mockAnalyzeTasteProfile.mockResolvedValue({
      archetype_name: "Explorer",
      archetype_summary: "Summary",
      preferred_pacing: "Fast",
      emotional_tone: "Tense",
      top_tropes: ["A", "B", "C"],
      dealbreakers: ["D", "E"],
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === "user_books") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: mockBooks, error: null }),
          }),
        };
      }
      return {
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      };
    });

    // Make 5 requests (should all succeed)
    for (let i = 0; i < 5; i++) {
      const req = new Request("http://localhost:3000/api/dna/recalculate", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.99.1" },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
    }

    // 6th request should be rate-limited with 429
    const req6 = new Request("http://localhost:3000/api/dna/recalculate", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.99.1" },
    });
    const res6 = await POST(req6);
    expect(res6.status).toBe(429);
    const json6 = await res6.json();
    expect(json6.error).toContain("Too many recalculation requests");
  });
});

import { describe, it, expect } from "vitest";

interface TestBook {
  id: string;
  book_id: string;
  title: string;
  author: string;
  shelf: "read" | "currently-reading" | "to-read" | "did-not-finish";
  rating: number | null;
  date_read: string | null;
}

// Extraction helper matching app/library/page.tsx
function extractYearOptionsAndLifetime(books: TestBook[]) {
  const readBooks = books.filter((b) => b.shelf === "read");
  const yearCountMap = new Map<number, number>();
  let lifetime = 0;

  for (const b of readBooks) {
    if (b.date_read) {
      const d = new Date(b.date_read);
      if (!isNaN(d.getTime())) {
        const yr = d.getFullYear();
        yearCountMap.set(yr, (yearCountMap.get(yr) || 0) + 1);
      } else {
        lifetime++;
      }
    } else {
      lifetime++;
    }
  }

  const sortedYears = Array.from(yearCountMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, count]) => ({ year, count }));

  return { yearOptions: sortedYears, lifetimeCount: lifetime };
}

// Filter helper matching app/library/page.tsx
function filterBooks(
  books: TestBook[],
  options: {
    activeShelf: string;
    selectedYear: number | "lifetime" | "all";
    minRating?: number | null;
    search?: string;
  }
) {
  const { activeShelf, selectedYear, minRating = null, search = "" } = options;

  return books.filter((book) => {
    // Shelf Filter
    if (
      activeShelf !== "all" &&
      activeShelf !== "recommended" &&
      activeShelf !== "series" &&
      book.shelf !== activeShelf
    ) {
      return false;
    }

    // Year / Lifetime Filter (Applies when viewing 'read' or 'all' shelf)
    if ((activeShelf === "read" || activeShelf === "all") && selectedYear !== "all") {
      if (selectedYear === "lifetime") {
        if (book.shelf !== "read" || book.date_read) {
          return false;
        }
      } else {
        if (!book.date_read) return false;
        const d = new Date(book.date_read);
        if (isNaN(d.getTime()) || d.getFullYear() !== selectedYear) {
          return false;
        }
      }
    }

    // Rating Filter
    if (minRating !== null && (!book.rating || book.rating < minRating)) {
      return false;
    }

    // Search Filter
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      const matchTitle = book.title.toLowerCase().includes(q);
      const matchAuthor = book.author.toLowerCase().includes(q);
      if (!matchTitle && !matchAuthor) return false;
    }

    return true;
  });
}

describe("Phase 9 / Issue #77: Dynamic Year-Read Filter & Lifetime Reads View", () => {
  const sampleBooks: TestBook[] = [
    {
      id: "1",
      book_id: "b1",
      title: "Project Hail Mary",
      author: "Andy Weir",
      shelf: "read",
      rating: 5,
      date_read: "2026-03-15T12:00:00Z",
    },
    {
      id: "2",
      book_id: "b2",
      title: "Dark Matter",
      author: "Blake Crouch",
      shelf: "read",
      rating: 4,
      date_read: "2026-05-10T14:30:00Z",
    },
    {
      id: "3",
      book_id: "b3",
      title: "Dune",
      author: "Frank Herbert",
      shelf: "read",
      rating: 5,
      date_read: "2025-11-20T10:00:00Z",
    },
    {
      id: "4",
      book_id: "b4",
      title: "The Way of Kings",
      author: "Brandon Sanderson",
      shelf: "read",
      rating: 5,
      date_read: "2025-08-04T09:00:00Z",
    },
    {
      id: "5",
      book_id: "b5",
      title: "The Hobbit",
      author: "J.R.R. Tolkien",
      shelf: "read",
      rating: 4,
      date_read: "2024-12-25T18:00:00Z",
    },
    {
      id: "6",
      book_id: "b6",
      title: "The Stand",
      author: "Stephen King",
      shelf: "read",
      rating: 5,
      date_read: null, // Lifetime read
    },
    {
      id: "7",
      book_id: "b7",
      title: "The Shining",
      author: "Stephen King",
      shelf: "read",
      rating: 4,
      date_read: null, // Lifetime read
    },
    {
      id: "8",
      book_id: "b8",
      title: "11/22/63",
      author: "Stephen King",
      shelf: "read",
      rating: 5,
      date_read: null, // Lifetime read
    },
    {
      id: "9",
      book_id: "b9",
      title: "Hyperion",
      author: "Dan Simmons",
      shelf: "to-read",
      rating: null,
      date_read: null,
    },
    {
      id: "10",
      book_id: "b10",
      title: "Children of Time",
      author: "Adrian Tchaikovsky",
      shelf: "currently-reading",
      rating: null,
      date_read: null,
    },
  ];

  describe("Requirement 1: Dynamic Year Span & Lifetime Reads Extraction", () => {
    it("extracts unique years in descending order with accurate counts", () => {
      const { yearOptions, lifetimeCount } = extractYearOptionsAndLifetime(sampleBooks);

      expect(yearOptions).toEqual([
        { year: 2026, count: 2 },
        { year: 2025, count: 2 },
        { year: 2024, count: 1 },
      ]);
      expect(lifetimeCount).toBe(3);
    });

    it("handles an empty library gracefully", () => {
      const { yearOptions, lifetimeCount } = extractYearOptionsAndLifetime([]);
      expect(yearOptions).toEqual([]);
      expect(lifetimeCount).toBe(0);
    });

    it("handles libraries with only lifetime reads (no dated reads)", () => {
      const lifetimeOnly: TestBook[] = [
        { id: "a", book_id: "ba", title: "Book A", author: "Author", shelf: "read", rating: 5, date_read: null },
        { id: "b", book_id: "bb", title: "Book B", author: "Author", shelf: "read", rating: 4, date_read: null },
      ];
      const { yearOptions, lifetimeCount } = extractYearOptionsAndLifetime(lifetimeOnly);
      expect(yearOptions).toEqual([]);
      expect(lifetimeCount).toBe(2);
    });
  });

  describe("Requirement 2 & 3: Filter By Specific Year", () => {
    it("filters to only books read in 2026 when selectedYear === 2026", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: 2026,
      });

      expect(result.length).toBe(2);
      expect(result.map((b) => b.title)).toEqual(["Project Hail Mary", "Dark Matter"]);
    });

    it("filters to only books read in 2025 when selectedYear === 2025", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: 2025,
      });

      expect(result.length).toBe(2);
      expect(result.map((b) => b.title)).toEqual(["Dune", "The Way of Kings"]);
    });

    it("filters to only books read in 2024 when selectedYear === 2024", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: 2024,
      });

      expect(result.length).toBe(1);
      expect(result[0].title).toBe("The Hobbit");
    });
  });

  describe("Requirement 4: Dedicated Lifetime Reads View", () => {
    it("isolates undated past reads when selectedYear === 'lifetime'", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: "lifetime",
      });

      expect(result.length).toBe(3);
      expect(result.map((b) => b.title)).toEqual(["The Stand", "The Shining", "11/22/63"]);
      result.forEach((b) => {
        expect(b.shelf).toBe("read");
        expect(b.date_read).toBeNull();
      });
    });

    it("works when activeShelf is 'all' with selectedYear === 'lifetime'", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "all",
        selectedYear: "lifetime",
      });

      expect(result.length).toBe(3);
      expect(result.every((b) => b.shelf === "read" && b.date_read === null)).toBe(true);
    });
  });

  describe("Requirement 5: Multi-Filter Synergy (Year + Rating + Search)", () => {
    it("filters by Year and 5-Star Rating simultaneously", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: 2026,
        minRating: 5,
      });

      expect(result.length).toBe(1);
      expect(result[0].title).toBe("Project Hail Mary");
    });

    it("filters by Lifetime Reads and Search query", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: "lifetime",
        search: "Stand",
      });

      expect(result.length).toBe(1);
      expect(result[0].title).toBe("The Stand");
    });

    it("filters by Lifetime Reads and 5-Star Rating", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: "lifetime",
        minRating: 5,
      });

      expect(result.length).toBe(2);
      expect(result.map((b) => b.title)).toEqual(["The Stand", "11/22/63"]);
    });

    it("resets to All Years correctly", () => {
      const allRead = filterBooks(sampleBooks, {
        activeShelf: "read",
        selectedYear: "all",
      });

      expect(allRead.length).toBe(8); // 5 dated + 3 lifetime
    });
  });

  describe("Requirement 6: Non-Read Shelf Protection", () => {
    it("does not apply year filter to 'to-read' shelf books", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "to-read",
        selectedYear: 2026,
      });

      // 'to-read' shelf books should remain visible on to-read shelf
      expect(result.length).toBe(1);
      expect(result[0].title).toBe("Hyperion");
    });

    it("does not apply year filter to 'currently-reading' shelf books", () => {
      const result = filterBooks(sampleBooks, {
        activeShelf: "currently-reading",
        selectedYear: 2026,
      });

      expect(result.length).toBe(1);
      expect(result[0].title).toBe("Children of Time");
    });
  });
});

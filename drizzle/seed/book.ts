import { faker } from '@faker-js/faker';
import { sql } from 'drizzle-orm';

import { book, genre, getDefaultDbClient } from '@/modules/kernel/backend';

import data from './book-data.json';

export async function createBooks() {
  const db = getDefaultDbClient();
  console.log(`⏳ Seeding books`);

  let createdCounter = 0;
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(book);
  const existingCount = countRow?.count ?? 0;
  const existingGenresAfterSeed = await db.select().from(genre);

  if (existingGenresAfterSeed.length > 0) {
    const booksToSeed = data.books.map(({ author, title }, index) => {
      const deterministicGenre =
        existingGenresAfterSeed[index % existingGenresAfterSeed.length]!;

      return {
        author,
        title,
        genreId: deterministicGenre.id,
        publisher: faker.book.publisher(),
      };
    });

    if (booksToSeed.length > 0) {
      const inserted = await db
        .insert(book)
        .values(booksToSeed)
        .onConflictDoNothing()
        .returning({ id: book.id });
      createdCounter = inserted.length;
    }
  }

  console.log(
    `✅ ${existingCount} existing books 👉 ${createdCounter} books created`
  );
}

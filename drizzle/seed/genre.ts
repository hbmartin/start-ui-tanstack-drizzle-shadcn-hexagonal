import { genre, getDefaultDbClient } from '@/modules/kernel/backend';

const demoGenres = [
  ['Adventure', '#9F0712'],
  ['Business', '#973C00'],
  ['Classic', '#3C6300'],
  ['Drama', '#006045'],
  ['Fantasy', '#005F78'],
  ['Mythology', '#193CB8'],
  ['Poetry', '#5D0EC0'],
  ['Romance', '#6E11B0'],
  ['Science Fiction', '#8A0194'],
  ['Thriller', '#A50036'],
] as const;

export async function createGenres() {
  console.log(`⏳ Seeding genres`);
  const db = getDefaultDbClient();
  const existingGenres = await db.select().from(genre);
  const existingNames = new Set(existingGenres.map(({ name }) => name));
  const values = demoGenres
    .filter(([name]) => !existingNames.has(name))
    .map(([name, color]) => ({ name, color }));

  const inserted =
    values.length === 0
      ? []
      : await db
          .insert(genre)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: genre.id });

  console.log(
    `✅ ${existingGenres.length} existing genres 👉 ${inserted.length} genres created`
  );
}

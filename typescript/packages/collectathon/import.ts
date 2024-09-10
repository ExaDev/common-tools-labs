import { db } from "./db.ts";
import { walk, ensureDir } from "./deps.ts";
import { getOrCreateCollection } from "./collections.ts";

export async function importFiles(path: string, collectionName: string) {
  try {
    const fullPath = await Deno.realPath(path);
    const fileInfo = await Deno.stat(fullPath);

    db.query("BEGIN TRANSACTION");

    const collectionId = getOrCreateCollection(collectionName);
    let itemCount = 0;
    let updatedCount = 0;

    if (fileInfo.isDirectory) {
      for await (const entry of walk(fullPath, { includeDirs: false })) {
        const result = await processFile(entry.path, collectionId, fullPath);
        if (result === "updated") {
          updatedCount++;
        } else {
          itemCount++;
        }
      }
    } else {
      const result = await processFile(fullPath, collectionId, Deno.cwd());
      if (result === "updated") {
        updatedCount++;
      } else {
        itemCount++;
      }
    }

    db.query("COMMIT");

    console.log(
      `Imported ${itemCount} new file(s) and updated ${updatedCount} existing file(s) in collection: ${collectionName}`
    );
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error importing files: ${error.message}`);
  }
}

async function processFile(
  filePath: string,
  collectionId: number,
  basePath: string
): Promise<"new" | "updated"> {
  const relativePath = filePath.replace(basePath, "").replace(/^\//, "");
  const content = await Deno.readTextFile(filePath);
  const fileUrl = `file://${filePath}`;

  const contentJson = {
    path: relativePath,
    content: content,
  };

  // Check if the file already exists in the database
  const existingItem = db.query<[number]>(
    "SELECT id FROM items WHERE url = ?",
    [fileUrl]
  );

  if (existingItem.length > 0) {
    // Update existing record
    const itemId = existingItem[0][0];
    db.query(
      "UPDATE items SET title = ?, content = ?, raw_content = ? WHERE id = ?",
      [relativePath, JSON.stringify(contentJson), content, itemId]
    );

    // Ensure the item is associated with the current collection
    db.query(
      "INSERT OR IGNORE INTO item_collections (item_id, collection_id) VALUES (?, ?)",
      [itemId, collectionId]
    );

    return "updated";
  } else {
    // Insert new record
    const result = db.query(
      "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
      [
        fileUrl,
        relativePath,
        JSON.stringify(contentJson),
        content,
        "Local File",
      ]
    );
    const itemId = result[0][0] as number;

    db.query(
      "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
      [itemId, collectionId]
    );

    return "new";
  }
}

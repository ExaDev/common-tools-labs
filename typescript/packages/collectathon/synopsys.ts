import { CID, json, sha256 } from "./deps.ts";

export function entity(id: string) {
  return { "/": id }
}

type Entity = ReturnType<typeof entity>;
type Attribute = string;
type Value = Entity | string | number | boolean;
type Fact = [Entity, Attribute, Value];

const SYNOPSYS_URL = Deno.env.get('SYNOPSYS_URL') || 'http://localhost:8080'

export async function cid(data: any) {
  const bytes = json.encode(data)
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, json.code, hash)
  console.log('cid', cid.toString(), data)
  return cid.toString()
}

export async function jsonToFacts(data: any) {
  const facts: Fact[] = [];
  const processObject = (obj: any, parentEntity?: Entity) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null) {
        if ('/' in value) {
          // This is an Entity
          facts.push([parentEntity as Entity, key, value as Entity]);
        } else {
          // Ignore nested objects that are not Entities
          continue;
        }
      } else if (typeof value !== 'function') {
        facts.push([parentEntity as Entity, key, value]);
      }
    }
  };

  if (typeof data === 'object' && data !== null) {
    if ('/' in data) {
      // The root object is an Entity
      processObject(data, data as Entity);
    } else {
      // The root object is not an Entity, create a new one
      const rootEntity = entity(await cid(data));
      processObject(data, rootEntity);
    }
  }

  return facts;
}

export async function assert(...facts: Fact[]) {
  const body = JSON.stringify(facts.map(f => ({ Assert: f })))
  console.log('URL', SYNOPSYS_URL, body)
  const response = await fetch(SYNOPSYS_URL, {
    method: 'PATCH',
    body
  })
  if (!response.ok) {
    throw new Error(`Error asserting facts: ${response.statusText}`)
  }

  return await response.json()
}

export async function* query() {
  const request = await fetch(SYNOPSYS_URL, {
    method: "PUT",
    body: JSON.stringify({
      select: {
        id: "?list",
        name: "?name",
        todo: [{
          "id": "?item",
          "title": "?title",
          "completed": "?done"
        }]
      },
      where: [
        { Case: ["?list", "name", "?name"] },
        { Case: ["?list", "todo", "?item"] },
        { Case: ["?item", "title", "?title"] },
        {
          Or: [
            { Case: ["?item", "done", "?done"] },
            {
              And: [
                { Not: { Case: ["?item", "done", "?done"] } },
                { "Is": ["?done", false] }
              ]
            }
          ]
        }
      ]
    })
  })

  const reader = request.body?.getReader()
  const utf8 = new TextDecoder()
  if (!reader) {
    throw new Error('No reader')
  }

  while (true) {
    const read = await reader.read()
    if (read.done) {
      break
    } else {
      const [id, event, data] =
        utf8.decode(read.value).split('\n')

      yield {
        id: id.slice('id:'.length),
        event: event.slice('event:'.length),
        data: JSON.parse(data.slice('data:'.length))
      }
    }
  }
}

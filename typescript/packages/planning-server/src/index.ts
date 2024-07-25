import { ask } from "./anthropic.ts";
import { serve } from "./deps.ts";
import {
  InMemoryConversationThreadManager,
  ConversationThread,
} from "./conversation.ts";
import { CoreMessage, CoreTool } from "npm:ai";
import { CoreAssistantMessage } from "npm:ai";

const threadManager = new InMemoryConversationThreadManager();

type CreateConversationThreadRequest = {
  action: "create";
  message: string;
  system: string;
  activeTools: CoreTool[];
};

type AppendToConversationThreadRequest = {
  action: "append";
  threadId: string;
  message?: string;
};

type ConversationThreadRequest =
  | CreateConversationThreadRequest
  | AppendToConversationThreadRequest;

const handler = async (request: Request): Promise<Response> => {
  if (request.method === "POST") {
    try {
      const body: ConversationThreadRequest = await request.json();
      const { action } = body;

      switch (action) {
        case "create": {
          const { message, system, activeTools } = body;
          return handleCreateConversationThread(system, message, activeTools);
        }
        case "append": {
          const { threadId, message } = body;
          return handleAppendToConversationThread(threadId, message);
        }
        default:
          return new Response(JSON.stringify({ error: "Invalid action" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    return new Response("Please send a POST request", { status: 405 });
  }
};

const cache: Record<string, any> = {};

async function handleCreateConversationThread(
  system: string,
  message: string,
  activeTools: CoreTool[]
): Promise<Response> {
  const cacheKey = `${system}:${message}`;

  if (cache[cacheKey]) {
    console.log(
      "Cache hit!",
      (cacheKey.slice(0, 20) + "..." + cacheKey.slice(-20)).replaceAll("\n", "")
    );
    return new Response(JSON.stringify(cache[cacheKey]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const thread = threadManager.create(system, message, activeTools);
  const result = await processConversationThread(thread);
  if (result.type === "error") {
    return new Response(JSON.stringify(result), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (result.assistantResponse) {
    threadManager.update(thread.id, [result.assistantResponse]);
  }

  // cache[cacheKey] = result;

  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleAppendToConversationThread(
  threadId: string,
  message?: string
): Promise<Response> {
  const thread = threadManager.get(threadId);
  if (!thread) {
    return new Response(JSON.stringify({ error: "Thread not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (message) {
    threadManager.update(threadId, [
      {
        role: "user",
        content: message,
      },
    ]);
  }

  const result = await processConversationThread(thread);
  if (result.type === "error") {
    return new Response(JSON.stringify(result), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Update the thread with the assistant's response
  if (result.assistantResponse) {
    threadManager.update(threadId, [result.assistantResponse]);
  }

  // Remove the assistantResponse from the result before sending it to the client
  const { assistantResponse, ...responseToClient } = result;

  return new Response(JSON.stringify(responseToClient), {
    headers: { "Content-Type": "application/json" },
  });
}

type ProcessConversationThreadResult =
  | {
      type: "success";
      threadId: string;
      output: string;
      assistantResponse: CoreAssistantMessage;
      conversation: CoreMessage[];
    }
  | { type: "error"; error: string };

async function processConversationThread(
  thread: ConversationThread
): Promise<ProcessConversationThreadResult> {
  console.log("Thread", thread);

  const result = await ask(
    thread.conversation,
    thread.system,
    thread.activeTools
  );
  if (!result) {
    return { type: "error", error: "No response from Anthropic" };
  }

  // Find the new assistant's response (it should be the last message)
  const assistantResponse = result[result.length - 1];
  if (assistantResponse.role !== "assistant") {
    return { type: "error", error: "No assistant response found" };
  }

  if (Array.isArray(assistantResponse.content)) {
    assistantResponse.content = assistantResponse.content
      .filter((msg) => msg.type == "text")
      .map((msg) => msg.text)
      .join(" ");
  }

  const output = assistantResponse.content;
  console.log("Output=", output);
  return {
    type: "success",
    threadId: thread.id,
    output,
    assistantResponse,
    conversation: result,
  };
}

const port = Deno.env.get("PORT") || "8000";
console.log(`HTTP webserver running. Access it at: http://localhost:${port}/`);
await serve(handler, { port: parseInt(port) });

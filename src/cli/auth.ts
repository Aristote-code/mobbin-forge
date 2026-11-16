import readline from "node:readline";
import { writeStoredSession } from "../utils/auth-store.js";
import { MobbinApiClient } from "../services/api-client.js";
import { MobbinAuth } from "../services/auth.js";

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function runAuthFlow(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\nMobbin MCP Authentication\n");
    console.log("1. Open mobbin.com and log in");
    console.log("2. Open the browser console (Cmd+Option+J)");
    console.log("3. Paste this and press Enter:\n");
    console.log("   copy(document.cookie)\n");
    console.log("4. Paste the result below:\n");

    const cookie = (await prompt(rl, "Cookie: ")).trim();
    if (!cookie) {
      console.error("No cookie provided.");
      process.exit(1);
    }

    const auth = MobbinAuth.fromCookie(cookie);
    console.log("Validating the Mobbin session…");
    await auth.getCookieValue();
    await new MobbinApiClient(auth).getCollections();
    writeStoredSession(auth.getSession());

    console.log(
      "\nAuthenticated successfully! Session saved to ~/.mobbin-mcp/auth.json" +
        "\nYou can now use the MCP server without setting MOBBIN_AUTH_COOKIE.\n",
    );
  } finally {
    rl.close();
  }
}

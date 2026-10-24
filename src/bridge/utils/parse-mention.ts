// Reads an "@agent message" from the text the human typed.
// Never check here that the agent exists. The bridge looks it up in the registry.

// The agent name (lowercase, without "@") and the message after it.
export interface MentionResult {
  agentName: string;
  messageText: string;
}

// Name starts with a letter, then letters, digits, "_" or "-". `[\s\S]*\S` allows many
// lines and drops trailing space. The message is required, so "@name" alone fails.
const MENTION_PATTERN = /^\s*@([a-z][a-z0-9_-]*)\s+([\s\S]*\S)\s*$/i;

// Null when the text does not start with "@name message". The name is lowercased.
export function parseMention({
  inputText,
}: {
  inputText: string;
}): MentionResult | null {
  const match = MENTION_PATTERN.exec(inputText);
  if (!match) return null;

  const [, agentName, messageText] = match;
  // For the type checker only: the pattern guarantees both groups.
  if (!agentName || !messageText) return null;

  return { agentName: agentName.toLowerCase(), messageText };
}

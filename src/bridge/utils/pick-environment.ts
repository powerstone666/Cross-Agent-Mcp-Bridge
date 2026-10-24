// Builds a smaller set of environment variables for a child process.
// Never copy a variable that is not in the allow list.

interface PickEnvironmentInput {
  environment: NodeJS.ProcessEnv;
  allowedNames: readonly string[];
}

// Returns a new environment with only the allowed names that are set. The parent
// environment may hold unrelated secrets, so the agent gets a small known set.
export function pickEnvironment({
  environment,
  allowedNames,
}: PickEnvironmentInput): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const name of allowedNames) {
    const value = environment[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

// Checks that a text setting is one of an allowed list of values.
// Never accept an unknown value quietly.

interface ReadChoiceInput<Choice extends string> {
  // Used in the error message.
  name: string;
  value: string | undefined;
  allowedValues: readonly Choice[];
  // Returned when the value is not set.
  defaultValue: Choice;
}

// Throws, listing the allowed values, on anything else. A typo in a safety setting such
// as an approval policy must fail loudly, not fall back to the default.
export function readChoice<Choice extends string>({
  name,
  value,
  allowedValues,
  defaultValue,
}: ReadChoiceInput<Choice>): Choice {
  if (value === undefined) return defaultValue;
  const match = allowedValues.find((allowedValue) => allowedValue === value);
  if (match === undefined) {
    throw new Error(`${name} must be one of: ${allowedValues.join(", ")}`);
  }
  return match;
}

// Like readChoice, but returns null when the variable is not set, so the agent's own default applies.
export function readOptionalChoice<Choice extends string>({
  name,
  value,
  allowedValues,
}: Omit<ReadChoiceInput<Choice>, "defaultValue">): Choice | null {
  if (value === undefined) return null;
  return readChoice({ name, value, allowedValues, defaultValue: allowedValues[0] as Choice });
}

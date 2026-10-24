// Removes escape codes and control characters from text an agent wrote, so it cannot
// redraw the screen or fake an approval prompt. Keeps tabs and line breaks.
const CONTROL_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function stripTerminalControl(text: string): string {
  return text.replace(CONTROL_SEQUENCES, "").replace(CONTROL_CHARACTERS, "");
}

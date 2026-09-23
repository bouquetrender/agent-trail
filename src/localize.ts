import * as vscode from "vscode";

export function localize(english: string, chinese: string): string {
  return /^zh(?:-|$)/i.test(vscode.env.language) ? chinese : english;
}

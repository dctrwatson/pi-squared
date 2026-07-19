/** A model-Bash command policy backed by a dedicated wrapper directory. */
export interface BashCommandInterceptor {
  /** Stable identifier for the registry and diagnostics. */
  readonly name: string;
  /** Directory prepended to the model Bash tool's PATH. */
  readonly binDir: string;
  /** Per-turn model guidance for commands shadowed by this policy. */
  readonly systemPromptGuidance: string;
}

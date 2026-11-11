/** What the levels read of an invite profile's preset: the levels it names. */
export interface PresetLevels {
  readonly levels?: Readonly<Record<string, string>>;
}

/**
 * The invite profiles' presets (KBC-109), as the levels services read them: a removal's
 * preview counts those naming the level, and a new level never takes an id one of them still
 * names (KBC-108 QA-2). The profiles load after the levels, so the composition root binds them.
 */
export class InvitePresetLevels {
  private source: () => readonly PresetLevels[] = () => [];

  bind(source: () => readonly PresetLevels[]): void {
    this.source = source;
  }

  list(): readonly PresetLevels[] {
    return this.source();
  }

  /** The level ids of `root` the presets name. */
  idsIn(root: string): Set<string> {
    return new Set(
      this.list().flatMap((one) => {
        const level = one.levels?.[root];
        return level === undefined ? [] : [level];
      }),
    );
  }
}

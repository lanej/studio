import {
  matchesKey,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { NavigationKey } from "../runtime.ts";
import type { WorkerAssignment } from "../tasks/workers.ts";

interface WorkerActions {
  changed(): void;
  inspect(row: WorkerAssignment): void;
  focusPane(row: WorkerAssignment): void;
}

/** The sidebar draws the rows. Pi owns keyboard focus and restores the lead's draft. */
export class WorkerNavigation {
  collapsed = false;
  selectedAttemptId: string | undefined;
  private rows: readonly WorkerAssignment[] = [];
  private handle: OverlayHandle | undefined;

  get focused(): boolean {
    return this.handle?.isFocused() === true;
  }

  setRows(rows: readonly WorkerAssignment[]): void {
    this.rows = rows;
    if (
      this.selectedAttemptId !== undefined &&
      !rows.some((row) => row.attemptId === this.selectedAttemptId)
    ) {
      this.selectedAttemptId = undefined;
      this.leave();
    }
  }

  reset(): void {
    this.leave();
    this.rows = [];
    this.collapsed = false;
    this.selectedAttemptId = undefined;
  }

  leave(): void {
    this.handle?.hide();
    this.handle = undefined;
  }

  toggleFold(): void {
    this.collapsed = !this.collapsed;
  }

  toggleFocus(tui: Pick<TUI, "showOverlay">, actions: WorkerActions): void {
    const wasFocused = this.focused;
    this.leave();
    const first = this.rows[0];
    if (!wasFocused && first !== undefined) {
      this.collapsed = false;
      this.selectedAttemptId ??= first.attemptId;
      // An empty overlay owns only input. A later Pi dialog can take focus normally.
      this.handle = tui.showOverlay(
        {
          invalidate() {},
          render: () => [],
          handleInput: (key) => {
            this.handleInput(key, actions);
          },
        },
        { width: 1 },
      );
    }
    actions.changed();
  }

  private handleInput(key: string, actions: WorkerActions): void {
    if (
      matchesKey(key, NavigationKey.Escape) ||
      matchesKey(key, NavigationKey.Cancel) ||
      matchesKey(key, "alt+w")
    ) {
      this.leave();
    } else if (matchesKey(key, "space")) {
      this.toggleFold();
    } else if (!this.collapsed) {
      const index = this.rows.findIndex(
        (row) => row.attemptId === this.selectedAttemptId,
      );
      const row = this.rows[index];
      if (row === undefined) return;
      if (matchesKey(key, NavigationKey.Enter)) {
        this.leave();
        actions.inspect(row);
      } else if (matchesKey(key, NavigationKey.Right) && row.focusable) {
        this.leave();
        actions.focusPane(row);
      } else if (
        matchesKey(key, NavigationKey.Down) ||
        matchesKey(key, NavigationKey.VimDown)
      ) {
        this.selectedAttemptId = (this.rows[index + 1] ?? row).attemptId;
      } else if (
        matchesKey(key, NavigationKey.Up) ||
        matchesKey(key, NavigationKey.VimUp)
      ) {
        this.selectedAttemptId = (this.rows[index - 1] ?? row).attemptId;
      }
    }
    actions.changed();
  }
}

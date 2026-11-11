---
name: notes
description: Update notes.md with what changed. Rewrites sections in place, never appends a log. Use when the user types /notes or asks to update the notes.
---

Update `notes.md` to match the current state of the project.

1. Read `notes.md` in full.
2. Gather what's new: this conversation, plus `git log` / `git diff` if there are commits.
3. For each new point, find the section it belongs to:
   - Same topic exists → rewrite that point.
   - Decision changed → update it; move the old choice to "Considered & rejected" with a short reason.
   - Point no longer true → delete it.
   - Truly new → add one short line in the right section.
   - A question got answered → move it out of "Open questions".
4. Merge duplicates. Keep it to about one page, with short plain bullets.
5. Also update `plan.md` to match: same changes, plan wording.
6. Show the user the changed lines in both files (before → after) and wait for OK before saving. Don't commit separately: the changes go into the commit of the phase's last step.

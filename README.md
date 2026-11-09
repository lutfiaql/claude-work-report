# Work Report for Claude Code

A Claude Code mod that shows what Claude has finished for you: how many tasks, an estimate of the hours that saved you, and what that time is worth. It sits in a pane beside the chat with four tabs: Today, Week, Month and Year.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install work-report --marketplace lutfiaql/claude-work-report
```

Answer `y` to add the marketplace, then pick a scope (user scope keeps it on in every session).

From a shell:

```
claude plugin install work-report --marketplace lutfiaql/claude-work-report
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `lutfiaql/claude-work-report`, then Add plugin.

## Use

- `/report` opens the pane. `/report today`, `/report week`, `/report month` and `/report year` open it on that tab.
- The **Report** chip in the prompt footer opens it too.
- `/report settings` lists the estimate's inputs. `/report settings rate 75` changes the hourly rate; `/report settings coding 15` changes the minutes saved per task of a kind (`emails`, `documents`, `images`, `coding`, `research`, `other`).
- `/report rebuild` recounts every day from your Claude Code session history.

## What it shows

- **Three tiles:** hours saved, tasks done and dollars' worth, each with the change against the previous stretch (yesterday, the previous 7 or 30 days, last year).
- **Where the time went:** tasks and hours per kind.
- **Who did the work:** tasks per model.
- **Where you worked:** tasks per project folder.
- **A chart:** the last seven days by weekday, thirty daily bars with the average, or January to December, today or this month in gold.
- **Year:** a calendar heatmap of every day.
- A streak, or the best day or month and the number of active days.

The desktop app, the editor and mobile get crisp SVG charts; the terminal gets a text version drawn with box characters, sized to the pane so nothing wraps.

## How a task is counted

One prompt you type that finishes with an answer is one task. Slash commands, helper agents, tool steps, cancelled or failed turns, background notifications and messages from other sessions do not count. Each task is sorted by the tools it used, the first match winning: Emails (mail tools), Images and video, Documents (document, slide or spreadsheet tools, or writing a document file), Coding (editing files or running commands), Research (web search, page reading, transcripts), Other.

On first load the mod rebuilds past days from Claude Code's own session history (`~/.claude/projects`), read locally by a short Python 3 script; nothing leaves your machine. From then on it records each finished task as it happens. It keeps one small record per day in its own store.

## The estimate

Minutes saved per task: Emails 10, Documents 30, Images and video 20, Coding 20, Research 25, Other 10, at $50 an hour. Hours and dollars are always shown as estimates; change the inputs with `/report settings`.

## Requirements

Claude Code with mods (function hooks) support, and `python3` on the PATH for the history rebuild. Without Python the mod still records new tasks live.

## License

MIT

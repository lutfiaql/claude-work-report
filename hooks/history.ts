// Reads past work from Claude Code's own session history, so the Week, Month
// and Year tabs cover the time before the mod was installed. The mod has no
// file access of its own fit for 400 MB of transcripts, so a short Python
// script (sent on stdin, nothing written to disk) reads them and prints one
// compact line per finished task; the mod sorts and dates them itself.

export const SCAN_SCRIPT = String.raw`
import json, os, sys, glob, hashlib
from datetime import datetime

root = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'projects')
until = float(sys.argv[1]) if len(sys.argv) > 1 else 1e18
WRITES = {'Write', 'Edit', 'MultiEdit', 'NotebookEdit'}
SKIP_PREFIX = ('Caveat:', 'Background (from the session that started this one)')
models, model_ix, cwds, cwd_ix, tasks, seen = [], {}, [], {}, [], set()

def ts_of(o):
    t = o.get('timestamp')
    if not t: return None
    try: return datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp() * 1000
    except Exception: return None

def prompt_text(o):
    if o.get('isMeta') or o.get('isSidechain') or o.get('isCompactSummary'): return None
    m = o.get('message') or {}
    if m.get('role') != 'user': return None
    c = m.get('content')
    if isinstance(c, str): parts = [c]
    elif isinstance(c, list):
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c): return None
        parts = [b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text']
    else: return None
    text = ''
    for p in parts:
        s = p.strip()
        while s.startswith('<system-reminder>'):
            end = s.find('</system-reminder>')
            if end < 0: s = ''; break
            s = s[end + len('</system-reminder>'):].strip()
        if s: text += s + '\n'
    return text.strip()

def finish(t):
    if t and t['answered'] and not t['aborted'] and t['ts'] < until:
        key = (round(t['ts'] / 1000), t['hash'])
        if key in seen: return
        seen.add(key)
        m = t['model'] or 'unknown'
        if m not in model_ix: model_ix[m] = len(models); models.append(m)
        c = t['cwd'] or ''
        if c not in cwd_ix: cwd_ix[c] = len(cwds); cwds.append(c)
        worked = max(0, int(t['last'] - t['ts'])) if t['last'] else 0
        tasks.append([int(t['ts']), model_ix[m], sorted(t['uses']), cwd_ix[c], worked])

earliest = None
sessions = set()
for path in glob.glob(os.path.join(root, '*', '*.jsonl')):
    sessions.add(os.path.splitext(os.path.basename(path))[0])
    cur = None
    try: fh = open(path, encoding='utf-8', errors='replace')
    except Exception: continue
    with fh:
        for line in fh:
            if '"type":"user"' not in line and '"type":"assistant"' not in line and '"type": "user"' not in line and '"type": "assistant"' not in line: continue
            try: o = json.loads(line)
            except Exception: continue
            if o.get('isSidechain'): continue
            kind = o.get('type')
            if kind == 'user':
                text = prompt_text(o)
                if text is None: continue
                if text.startswith('[Request interrupted'):
                    if cur: cur['aborted'] = True
                    continue
                # Text the app or another session wrote (tags such as <task-notification>,
                # <command-name>, <side-sessions-event>) is no request typed by the person;
                # pasted text is.
                machine = text.startswith('<') and not text.startswith('<pasted_content')
                if not text or machine or text.startswith(SKIP_PREFIX) or text.startswith('/'):
                    finish(cur); cur = None; continue
                ts = ts_of(o)
                if ts is None: continue
                if earliest is None or ts < earliest: earliest = ts
                finish(cur)
                cur = {'ts': ts, 'last': None, 'cwd': o.get('cwd'), 'hash': hashlib.md5(text[:400].encode('utf-8', 'replace')).hexdigest()[:10],
                       'uses': set(), 'model': None, 'answered': False, 'aborted': False}
            elif kind == 'assistant' and cur is not None:
                m = o.get('message') or {}
                model = m.get('model')
                # The app's own stand-in replies (errors, "no response") are no answer.
                if model == '<synthetic>': continue
                if model: cur['model'] = model
                at = ts_of(o)
                if at is not None and at >= cur['ts']: cur['last'] = at
                for b in m.get('content') or []:
                    if not isinstance(b, dict): continue
                    if b.get('type') == 'text' and (b.get('text') or '').strip(): cur['answered'] = True
                    elif b.get('type') == 'tool_use':
                        name = str(b.get('name') or '')
                        inp = b.get('input') if isinstance(b.get('input'), dict) else {}
                        cur['uses'].add(name)
                        if name == 'Skill' and isinstance(inp.get('skill'), str): cur['uses'].add('skill:' + inp['skill'])
                        f = inp.get('file_path') or inp.get('notebook_path')
                        if name in WRITES and isinstance(f, str) and '.' in os.path.basename(f):
                            cur['uses'].add('file:' + f.rsplit('.', 1)[1].lower()[:8])
        finish(cur)

# Claude Code deletes old transcripts (cleanupPeriodDays, 30 by default) but keeps
# the prompts typed in a terminal in history.jsonl. A session whose transcript is
# gone still counts its typed prompts, its kind and model unknown.
history = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'history.jsonl')
try:
    with open(history, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            try: o = json.loads(line)
            except Exception: continue
            if not isinstance(o, dict) or o.get('sessionId') in sessions: continue
            text = str(o.get('display') or '').strip()
            ts = o.get('timestamp')
            if not text or text.startswith('/') or not isinstance(ts, (int, float)) or ts >= until: continue
            if earliest is None or ts < earliest: earliest = ts
            finish({'ts': float(ts), 'last': None, 'cwd': o.get('project'), 'hash': hashlib.md5(text[:400].encode('utf-8', 'replace')).hexdigest()[:10],
                    'uses': set(), 'model': 'unknown', 'answered': True, 'aborted': False})
except OSError:
    pass

json.dump({'models': models, 'cwds': cwds, 'tasks': tasks, 'earliest': earliest}, sys.stdout, separators=(',', ':'))
`

import type { ToolUse } from './logic'

export type Scan = {
  models: string[]
  cwds: string[]
  tasks: Array<[number, number, string[], number?, number?]>
  /** The earliest moment the history still covers; days before it are kept as stored. */
  earliest: number | null
}

/** One scanned task's tokens back into the tool uses `classify` reads. */
export function usesOf(tokens: readonly string[]): ToolUse[] {
  return tokens.map(t => {
    if (t.startsWith('skill:')) return { tool: 'Skill', skill: t.slice(6) }
    if (t.startsWith('file:')) return { tool: 'Write', file: `file.${t.slice(5)}` }
    return { tool: t }
  })
}

export function parseScan(text: string): Scan | null {
  try {
    const raw = JSON.parse(text) as Partial<Scan>
    if (!Array.isArray(raw.models) || !Array.isArray(raw.tasks)) return null
    const cwds = Array.isArray(raw.cwds) ? raw.cwds.map(String) : []
    const earliest = typeof raw.earliest === 'number' ? raw.earliest : null
    return { models: raw.models.map(String), cwds, tasks: raw.tasks as Scan['tasks'], earliest }
  } catch {
    return null
  }
}

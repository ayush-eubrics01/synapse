import { type DiffFileView, parseDiff } from "../../../lib/engineering";

export interface DiffViewerProps {
  /** The plain-text unified diff (repo content: untrusted, rendered as text only). */
  diffText: string;
  truncated?: boolean;
  /** Per-file counts from the backend, used when the diff text is missing or cut. */
  files?: Array<{ path: string; added: number; removed: number }>;
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="syn-diff-counts">
      <span className="syn-diff-count syn-diff-count--add">{`+${added}`}</span>{" "}
      <span className="syn-diff-count syn-diff-count--del">{`-${removed}`}</span>
    </span>
  );
}

function FileSection({ file, open }: { file: DiffFileView; open: boolean }) {
  return (
    <details className="syn-diff-file" open={open}>
      <summary className="syn-diff-summary">
        <span className="syn-diff-path">{file.path}</span>
        <Counts added={file.added} removed={file.removed} />
      </summary>
      <pre className="syn-diff-pre">
        {file.lines.map((l, i) => (
          // The diff is static text and never reorders, so the index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: static, append-only lines
          <span key={i} className={`syn-diff-line syn-diff-line--${l.kind}`}>
            {`${l.text}\n`}
          </span>
        ))}
      </pre>
    </details>
  );
}

/** A per-file collapsible diff. Every line is a text node: no HTML from the repo is ever interpreted. */
export function DiffViewer({ diffText, truncated = false, files = [] }: DiffViewerProps) {
  const parsed = parseDiff(diffText);
  return (
    <div className="syn-diff">
      {parsed.length > 0
        ? parsed.map((f, i) => <FileSection key={f.path} file={f} open={i === 0} />)
        : files.map((f) => (
            <div key={f.path} className="syn-diff-file syn-diff-file--bare">
              <span className="syn-diff-path">{f.path}</span>
              <Counts added={f.added} removed={f.removed} />
            </div>
          ))}
      {parsed.length === 0 && files.length > 0 && (
        <p className="syn-eng-note">The diff text is not available. Only the file list is shown.</p>
      )}
      {truncated && (
        <p className="syn-eng-note">The diff was cut at 200 KB; later changes are not shown.</p>
      )}
    </div>
  );
}

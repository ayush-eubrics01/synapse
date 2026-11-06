import { hueFor, initials } from "../../../lib/avatar";

export interface AvatarProps {
  id: string;
  name: string | null;
  kind?: "person" | "channel";
  size?: number;
}

/** Initials on a hue from the Slack id (spec D5); channels get a neutral "#" tile. */
export function Avatar({ id, name, kind = "person", size = 28 }: AvatarProps) {
  const box = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (kind === "channel") {
    return (
      <span className="syn-avatar syn-avatar--channel" style={box} aria-hidden="true">
        #
      </span>
    );
  }
  const h = hueFor(id);
  return (
    <span
      className="syn-avatar"
      style={{
        ...box,
        background: `oklch(var(--avBgL) 0.055 ${h})`,
        color: `oklch(var(--avFgL) 0.09 ${h})`,
      }}
      aria-hidden="true"
    >
      {initials(name, id)}
    </span>
  );
}

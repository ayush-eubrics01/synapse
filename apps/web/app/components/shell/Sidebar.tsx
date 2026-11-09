"use client";

import { ThemeSwitch } from "./ThemeSwitch";

export interface SidebarItem {
  id: string;
  label: string;
  count?: number;
  hot?: boolean;
}

export interface SidebarProps {
  items: SidebarItem[];
  active: string;
  onGo: (id: string) => void;
  footer: { addresses: { api: string; web: string } | null; lock: string };
}

export function Sidebar({ items, active, onGo, footer }: SidebarProps) {
  return (
    <aside className="syn-sidebar">
      <div className="syn-brand">
        <span className="syn-brand-tile" aria-hidden="true">
          S
        </span>
        <div>
          <div className="syn-brand-name">Synapse</div>
          <div className="syn-brand-sub">Engineering ops</div>
        </div>
      </div>
      <nav className="syn-nav" aria-label="Sections">
        <ul>
          {items.map((item) => {
            const on = item.id === active;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`syn-nav-item${on ? " is-active" : ""}`}
                  aria-current={on ? "true" : undefined}
                  onClick={() => onGo(item.id)}
                >
                  <span>{item.label}</span>
                  {item.count ? (
                    <span className={`syn-badge${item.hot ? " is-hot" : ""}`}>{item.count}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="syn-side-theme">
        <ThemeSwitch />
      </div>
      <div className="syn-side-bottom">
        <dl className="syn-side-foot">
          {footer.addresses && (
            <>
              <dt>api</dt>
              <dd>{footer.addresses.api}</dd>
              <dt>web</dt>
              <dd>{footer.addresses.web}</dd>
            </>
          )}
          <dt>eng lock</dt>
          <dd>{footer.lock}</dd>
        </dl>
        <p className="syn-side-note">
          Runs locally. Nothing leaves this machine without your approval.
        </p>
      </div>
    </aside>
  );
}

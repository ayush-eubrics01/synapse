import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Header } from "../app/components/header/Header";
import { DashboardSection } from "../app/components/layout/DashboardSection";
import { HiddenTray } from "../app/components/layout/HiddenTray";
import { LayoutPicker } from "../app/components/layout/LayoutPicker";

const noop = () => {};
const section = (over: Partial<Parameters<typeof DashboardSection>[0]> = {}) =>
  renderToString(
    <DashboardSection
      id="jira"
      label="Jira"
      width="full"
      collapsed={false}
      customising
      isFirst={false}
      isLast={false}
      canHide
      onMove={noop}
      onHide={noop}
      onCollapse={noop}
      onWidth={noop}
      {...over}
    >
      <p>CHILD-MARKER</p>
    </DashboardSection>,
  );

test("a customising section shows the five toolbar buttons", () => {
  const html = section();
  for (const t of ["Move up", "Move down", "Hide", "Collapse", "Half width"])
    expect(html).toContain(t);
  expect(html).toContain('id="jira"');
  expect(html).toContain("CHILD-MARKER");
  expect(section({ width: "half", collapsed: true })).toContain("Full width");
  expect(section({ collapsed: true })).toContain("Expand");
});

test("Needs you cannot be hidden, and the first section cannot move up", () => {
  const html = section({ id: "triage", label: "Needs you", canHide: false, isFirst: true });
  expect(html).not.toContain(">Hide<");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Move up/);
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Move down/);
});

test("outside customise mode there is no toolbar", () => {
  expect(section({ customising: false })).not.toContain("Move up");
});

test("a collapsed section renders its header and badge only", () => {
  const html = section({
    id: "inbox",
    label: "Inbox",
    count: 4,
    collapsed: true,
    customising: false,
  });
  expect(html).toContain("Inbox");
  expect(html).toContain(">4<");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("CHILD-MARKER");
});

test("hidden tray lists hidden sections with a Show button", () => {
  const html = renderToString(<HiddenTray hidden={["jira"]} onShow={noop} />);
  expect(html).toContain("Hidden sections");
  expect(html).toContain("Jira");
  expect(html).toContain(">Show<");
  expect(renderToString(<HiddenTray hidden={[]} onShow={noop} />)).toBe("");
});

test("layout picker disables delete on the active layout only", () => {
  const html = renderToString(
    <LayoutPicker
      layouts={[
        { id: "L1", name: "Default", isActive: true, updatedAt: "x" },
        { id: "L2", name: "Focus", isActive: false, updatedAt: "x" },
      ]}
      activeId="L1"
      onSwitch={noop}
      onSaveAs={noop}
      onRename={noop}
      onDelete={noop}
      onReset={noop}
    />,
  );
  expect(html).toContain("Default");
  expect(html).toContain("Focus");
  const deletes = html.match(/<button[^>]*>Delete/g) ?? [];
  expect(deletes.length).toBe(2);
  expect(deletes.filter((b) => b.includes("disabled")).length).toBe(1);
  expect(deletes[0]).toContain("disabled");
});

test("header toggle shows Done and aria-pressed while customising", () => {
  const render = (customising: boolean) =>
    renderToString(
      <Header
        overview={null}
        failure={null}
        now={null}
        onOpenPalette={noop}
        onToggleAway={noop}
        backfillStarted
        customising={customising}
        onToggleCustomise={noop}
      />,
    );
  expect(render(true)).toContain("Done");
  expect(render(true)).toContain('aria-pressed="true"');
  expect(render(false)).toContain("Customise");
  expect(render(false)).toContain('aria-pressed="false"');
});

test("a collapsed header has no dangling aria-controls; toolbar and tray entries are focus targets", () => {
  expect(section({ collapsed: true, customising: false })).not.toContain("aria-controls");
  expect(section()).toContain('tabindex="-1"');
  expect(renderToString(<HiddenTray hidden={["jira"]} onShow={noop} />)).toContain(
    'id="hidden-tray-jira"',
  );
});

const pickerProps = {
  layouts: [
    { id: "L1", name: "Default", isActive: true, updatedAt: "x" },
    { id: "L2", name: "Focus", isActive: false, updatedAt: "x" },
  ],
  activeId: "L1",
  onSwitch: noop,
  onSaveAs: noop,
  onRename: noop,
  onDelete: noop,
  onReset: noop,
};

test("busy disables every picker button, the tray Show and the section toolbar", () => {
  const picker = renderToString(<LayoutPicker {...pickerProps} busy />);
  const buttons = picker.match(/<button[^>]*>/g) ?? [];
  expect(buttons.length).toBeGreaterThan(5);
  for (const b of buttons) expect(b).toContain("disabled");
  expect(renderToString(<HiddenTray hidden={["jira"]} onShow={noop} busy />)).toMatch(
    /<button[^>]*disabled[^>]*>Show/,
  );
  const html = section({ busy: true });
  for (const t of ["Move down", "Hide", "Collapse", "Half width"])
    expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${t}`));
});

test("not busy leaves the picker, tray and toolbar enabled", () => {
  const picker = renderToString(<LayoutPicker {...pickerProps} busy={false} />);
  const disabled = (picker.match(/<button[^>]*>/g) ?? []).filter((b) => b.includes("disabled"));
  expect(disabled).toHaveLength(1); // Delete on the active layout
  expect(renderToString(<HiddenTray hidden={["jira"]} onShow={noop} busy={false} />)).not.toContain(
    "disabled",
  );
  expect(section({ busy: false })).not.toMatch(/<button[^>]*disabled[^>]*>(Move down|Hide|Half)/);
});

test("a collapsed header stays enabled while busy", () => {
  expect(section({ busy: true, customising: false, collapsed: true })).not.toContain("disabled");
});

import type { WorkspaceSnapshot } from '@parallel-pi/contracts';
type Session = WorkspaceSnapshot['sessions'][number];
export const NODE_WIDTH = 258,
  NODE_HEIGHT = 234,
  ROW_HEIGHT = 286;
/** A deterministic forest: display coordinates never redefine session/path identity. */
export function layoutSessions(sessions: Session[]) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (const session of sessions) {
    const parent = session.origin && byId.get(session.origin.sessionId);
    if (parent && parent.laneId === session.laneId && parent.id !== session.id) {
      const list = children.get(parent.id) ?? [];
      list.push(session);
      children.set(parent.id, list);
    } else roots.push(session);
  }
  const nodes: { session: Session; x: number; y: number; parentId?: string }[] = [];
  const visited = new Set<string>();
  const visit = (root: Session) => {
    const stack: { session: Session; depth: number; parentId?: string }[] = [
      { session: root, depth: 0 },
    ];
    while (stack.length) {
      const item = stack.pop()!;
      if (visited.has(item.session.id)) continue;
      visited.add(item.session.id);
      nodes.push({
        session: item.session,
        x: 18 + item.depth * 36,
        y: 28 + nodes.length * ROW_HEIGHT,
        parentId: item.parentId,
      });
      for (const child of [...(children.get(item.session.id) ?? [])].reverse())
        stack.push({ session: child, depth: item.depth + 1, parentId: item.session.id });
    }
  };
  roots.forEach(visit);
  // Corrupt/legacy relation metadata stays visible instead of causing a loop or hiding history.
  sessions.filter((session) => !visited.has(session.id)).forEach(visit);
  const positions = new Map(nodes.map((node) => [node.session.id, node]));
  const edges = nodes.flatMap((node) => {
    const parent = node.parentId && positions.get(node.parentId);
    return parent
      ? [
          {
            id: node.session.id,
            source: parent.session.id,
            kind: node.session.origin!.kind,
            label: node.session.origin!.kind === 'fork' ? '分叉' : '接续',
            x: node.x,
            y: node.y - 7,
            path: `M${parent.x + 10} ${parent.y + NODE_HEIGHT} V${node.y + 18} H${node.x}`,
          },
        ]
      : [];
  });
  return {
    nodes,
    edges,
    width: Math.max(294, ...nodes.map((node) => node.x + NODE_WIDTH + 18)),
    height: Math.max(170, nodes.length * ROW_HEIGHT + 28),
  };
}

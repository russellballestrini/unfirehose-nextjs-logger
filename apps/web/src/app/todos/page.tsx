'use client';

import { TodoBoard } from '@/components/TodoBoard';

/** Every project's todos. The per-project board is the same component,
 *  mounted on the project page with a `project` prop. */
export default function TodosPage() {
  return <TodoBoard />;
}

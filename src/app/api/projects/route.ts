import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { createProject, listProjects, projectInputSchema } from '@/server/services/tasks';

export const GET = userRoute(async ({ user }) => inUser(user.id, async (tx) => ({ projects: await listProjects(tx, user.id) })));
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, projectInputSchema);
  return inUser(user.id, async (tx) => ({ project: await createProject(tx, user.id, input) }));
});

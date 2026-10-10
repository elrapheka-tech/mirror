// Refuses npm and Yarn. The lockfile and workspace links are pnpm's.
const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('pnpm/')) {
  console.error('Use pnpm to install dependencies: pnpm install');
  process.exit(1);
}

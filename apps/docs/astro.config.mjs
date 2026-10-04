import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://starlight.astro.build/reference/configuration/
export default defineConfig({
  site: 'https://grada-run.github.io',
  base: '/grada',
  redirects: {
    '/adrs/001-initial-architecture/': '/grada/adrs/0001-s3-native-state-locking/',
  },
  integrations: [
    starlight({
      title: 'Grada',
      description: 'Provision production-ready AWS infrastructure and CI/CD pipelines in seconds.',
      customCss: ['./src/custom.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/grada-run/grada' },
      ],
      editLink: {
        baseUrl: 'https://github.com/grada-run/grada/edit/main/apps/docs/',
      },
      lastUpdated: true,
      sidebar: [
        {
          label: 'Deployment Guides',
          collapsed: true,
          items: [
            { label: 'Quickstart (5 minutes)', slug: 'guides/quickstart' },
            { label: 'Stack Architecture', slug: 'guides/architecture' },
            { label: 'CI/CD Pipeline & First Deploy', slug: 'guides/cicd-pipeline' },
            { label: 'Supported Frameworks', slug: 'guides/frameworks' },
            { label: 'Reference Implementations & Examples', slug: 'guides/examples' },
            { label: 'Dockerfiles & Containers', slug: 'guides/dockerfiles' },
            { label: 'Docker Compose', slug: 'guides/docker-compose' },
            { label: 'Background Workers', slug: 'guides/background-workers' },
            { label: 'Managed Database Connections', slug: 'guides/database-connections' },
            { label: 'Secrets Management', slug: 'guides/secrets-management' },
            { label: 'Ephemeral PR Previews', slug: 'guides/ephemeral-pr-previews' },
            { label: 'Understanding Your AWS Bill', slug: 'guides/understanding-your-bill' },
            { label: 'Troubleshooting AWS Credentials', slug: 'guides/aws-credentials' },
            { label: 'Re-running Init Safely', slug: 'guides/rerun-init' },
            { label: 'Headless Mode & Automation', slug: 'guides/headless' },
            { label: 'Static-Site Hosting', slug: 'guides/static-hosting' },
            { label: 'Alert Notifications', slug: 'guides/alert-notifications' },
            { label: 'Going-Live Checklist', slug: 'guides/going-live' },
          ],
        },
        {
          label: 'CLI Reference',
          collapsed: true,
          items: [
            { label: 'npx grada-run (init)', slug: 'cli/init' },
            { label: 'apply', slug: 'cli/apply' },
            { label: 'destroy', slug: 'cli/destroy' },
            { label: 'secrets', slug: 'cli/secrets' },
            { label: 'diagnose', slug: 'cli/diagnose' },
            { label: 'logs', slug: 'cli/logs' },
            { label: 'status', slug: 'cli/status' },
            { label: 'rollback', slug: 'cli/rollback' },
            { label: 'exec', slug: 'cli/exec' },
            { label: 'db', slug: 'cli/db' },
            { label: 'gc', slug: 'cli/gc' },
            { label: 'doctor', slug: 'cli/doctor' },
            { label: 'eject', slug: 'cli/eject' },
            { label: 'sync-ai', slug: 'cli/sync-ai' },
            { label: 'add', slug: 'cli/add' },
            { label: 'domain', slug: 'cli/domain' },
            { label: 'sleep & wake', slug: 'cli/sleep' },
            { label: 'drift', slug: 'cli/drift' },
            { label: 'alerts', slug: 'cli/alerts' },
            { label: 'mcp', slug: 'cli/mcp' },
          ],
        },
        {
          label: 'Platform Migrations',
          collapsed: true,
          items: [
            { label: 'Vercel (Next.js)', slug: 'migrations/nextjs-vercel-to-aws' },
            { label: 'Heroku (Procfile)', slug: 'migrations/heroku-procfile-to-aws' },
            { label: 'Vercel (Astro)', slug: 'migrations/astro-vercel-to-aws' },
            { label: 'Vercel (SvelteKit)', slug: 'migrations/sveltekit-vercel-to-aws' },
          ],
        },
        {
          label: 'Project Details',
          collapsed: true,
          items: [
            { label: 'Roadmap', slug: 'roadmap' },
            { label: 'Testing Strategy', slug: 'testing-strategy' },
          ],
        },
        {
          label: 'Architecture (ADRs)',
          collapsed: true,
          items: [
            { autogenerate: { directory: 'adrs' } }
          ],
        },
      ],
    }),
  ],
});

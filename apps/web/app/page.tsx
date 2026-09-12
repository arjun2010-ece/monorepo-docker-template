import { Job } from '@jobboard/shared';

// In a real app this page would be a server component fetching from the
// NestJS API. Kept minimal — the point of this repo is the Dockerfiles.
export default async function HomePage() {
  const res = await fetch(`${process.env.API_URL ?? 'http://localhost:3001'}/jobs`, {
    cache: 'no-store',
  });
  const jobs: Job[] = res.ok ? await res.json() : [];

  return (
    <main style={{ fontFamily: 'sans-serif', padding: 32 }}>
      <h1>Job Board</h1>
      <ul>
        {jobs.map((job) => (
          <li key={job.id}>
            <strong>{job.title}</strong> — {job.company} ({job.location})
          </li>
        ))}
      </ul>
    </main>
  );
}

interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  createdAt: string;
}

// In a real app this page would be a server component fetching from the
// NestJS API (deployed separately — see the backend-only branch of this repo).
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

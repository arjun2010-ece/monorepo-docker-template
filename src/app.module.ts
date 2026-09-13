import { Controller, Get, Module, Post, Body } from '@nestjs/common';

// Types previously shared via the monorepo's packages/shared are inlined here —
// this branch is a standalone backend. In a real single-repo API you'd keep
// them in a dedicated src/types.ts (or generate from a schema).
export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  salaryMin?: number;
  salaryMax?: number;
  createdAt: string;
}

export interface CreateJobDto {
  title: string;
  company: string;
  location: string;
  salaryMin?: number;
  salaryMax?: number;
}

const jobs: Job[] = [
  {
    id: '1',
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Remote',
    createdAt: new Date().toISOString(),
  },
];

@Controller('jobs')
export class JobsController {
  @Get()
  findAll(): Job[] {
    return jobs;
  }

  @Post()
  create(@Body() dto: CreateJobDto): Job {
    const job: Job = { id: String(jobs.length + 1), ...dto, createdAt: new Date().toISOString() };
    jobs.push(job);
    return job;
  }
}

@Module({ controllers: [JobsController] })
export class AppModule {}

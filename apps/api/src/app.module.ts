import { Controller, Get, Module, Post, Body } from '@nestjs/common';
import { CreateJobDto, Job } from '@jobboard/shared';

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

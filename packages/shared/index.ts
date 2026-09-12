// Shared types used by both the Next.js frontend and the NestJS API.
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

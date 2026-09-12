import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS so the Next.js frontend (different origin) can call the API.
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });

  // 0.0.0.0 is important in Docker: the container must listen on ALL
  // interfaces, or the port mapping / service mesh can never reach it.
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on 0.0.0.0:${port}`);
}
bootstrap();

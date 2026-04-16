# Interview Prep Platform — Backend

A Node.js + Express backend for an AI-powered interview preparation platform.

## Tech Stack
- Node.js + Express
- PostgreSQL + Prisma ORM
- Google Gemini API
- REST API architecture

## Features
- Resume storage (CRUD operations)
- AI-powered interview question generation from resume text
- Input validation and error handling

## Setup
1. Clone the repo
2. Run `npm install`
3. Create `.env` with `DATABASE_URL` and `GEMINI_API_KEY`
4. Run `npx prisma migrate dev`
5. Run `npx nodemon index.js`

require('dotenv').config()
console.log("EMAIL:", process.env.GMAIL_USER)
console.log("PASS:", process.env.GMAIL_PASS)
const express = require("express")
const cors = require("cors")
const app = express()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
app.use(cors())
app.use(express.json())
const { GoogleGenerativeAI } = require("@google/generative-ai")
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
console.log("API KEY loaded:", process.env.GEMINI_API_KEY ? "YES" : "NO")
const nodemailer = require('nodemailer')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
})

// ── BADGE DEFINITIONS ─────────────────────────────────────────────────────────
const BADGES = {
  FIRST_BLOOD:   { id: "first_blood",   label: "First Blood",   icon: "🎯", desc: "Complete your first session" },
  ON_FIRE:       { id: "on_fire",        label: "On Fire",       icon: "🔥", desc: "7 day streak" },
  CODE_WARRIOR:  { id: "code_warrior",   label: "Code Warrior",  icon: "💻", desc: "Correctness 8+ on 3 coding questions" },
  BIG_BRAIN:     { id: "big_brain",      label: "Big Brain",     icon: "🧠", desc: "All avg dimension scores 8+ in one session" },
  CLEAN_RECORD:  { id: "clean_record",   label: "Clean Record",  icon: "👁️", desc: "5 sessions with zero violations" },
  GRINDER:       { id: "grinder",        label: "Grinder",       icon: "🚀", desc: "Complete 10 sessions" },
  INTERVIEW_GOD: { id: "interview_god",  label: "Interview God", icon: "👑", desc: "Overall avg 8.5+ across 10 sessions" },
}

const LEVELS = [
  { level: 1, label: "Beginner",      minXP: 0 },
  { level: 2, label: "Apprentice",    minXP: 200 },
  { level: 3, label: "Intermediate",  minXP: 500 },
  { level: 4, label: "Advanced",      minXP: 1000 },
  { level: 5, label: "Expert",        minXP: 2000 },
  { level: 6, label: "Interview God", minXP: 5000 },
]

function getLevelFromXP(xp) {
  let current = LEVELS[0]
  for (const l of LEVELS) { if (xp >= l.minXP) current = l }
  return current
}

// ── XP CALCULATION ─────────────────────────────────────────────────────────────
function calculateXP(scores, violations, isStreak) {
  const breakdown = []
  let total = 0

  total += 50
  breakdown.push({ reason: "Session completed", xp: 50 })

  // scores is now array of { technicalDepth, clarity, confidenceTone } or { correctness, codeQuality, efficiency }
  // calculate avg per question then count high scorers
  const questionAvgs = scores.map(s => {
    const vals = Object.values(s).filter(v => v != null && typeof v === "number")
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  })

  const highScores = questionAvgs.filter(a => a >= 8).length
  if (highScores > 0) {
    const xp = highScores * 20
    total += xp
    breakdown.push({ reason: `${highScores} question(s) avg 8+`, xp })
  }

  if (questionAvgs.length > 0 && questionAvgs.every(a => a >= 8)) {
    total += 100
    breakdown.push({ reason: "Perfect session bonus!", xp: 100 })
  }

  if (isStreak) {
    total += 30
    breakdown.push({ reason: "Daily streak", xp: 30 })
  }

  const totalViolations = (violations.tabSwitch || 0) + (violations.faceAway || 0) + (violations.multipleFaces || 0)
  if (!violations.terminated && totalViolations === 0) {
    total += 25
    breakdown.push({ reason: "Zero violations", xp: 25 })
  }

  if (violations.terminated) {
    total = Math.max(0, total - 30)
    breakdown.push({ reason: "Session terminated penalty", xp: -30 })
  }

  return { total, breakdown }
}

// ── BADGE CHECKER ──────────────────────────────────────────────────────────────
async function checkAndAwardBadges(userId, currentBadges, allSessions, scores, streak) {
  const newBadges = [...currentBadges]
  const awarded = []

  function award(id) {
    if (!newBadges.includes(id)) {
      newBadges.push(id)
      const badge = Object.values(BADGES).find(b => b.id === id)
      if (badge) awarded.push(badge)
    }
  }

  if (allSessions.length >= 1) award("first_blood")
  if (streak >= 7) award("on_fire")
  if (allSessions.length >= 10) award("grinder")

  // clean record
  const cleanSessions = allSessions.filter(s => {
    const v = s.violations || {}
    return !v.terminated && (v.tabSwitch || 0) + (v.faceAway || 0) + (v.multipleFaces || 0) === 0
  })
  if (cleanSessions.length >= 5) award("clean_record")

  // big brain — all question avgs 8+ this session
  const allHigh = scores.every(s => {
    const vals = Object.values(s).filter(v => v != null && typeof v === "number")
    return vals.length > 0 && vals.reduce((a, b) => a + b, 0) / vals.length >= 8
  })
  if (allHigh) award("big_brain")

  // code warrior — coding correctness 8+ in 3 sessions
  const codingHighSessions = allSessions.filter(s =>
    s.scores && Array.isArray(s.scores) &&
    s.scores.some(q => q.category === "coding" && (q.correctness || 0) >= 8)
  ).length
  if (codingHighSessions >= 3) award("code_warrior")

  // interview god — overall avg 8.5+ across 10 sessions
  if (allSessions.length >= 10) {
    const allAvgs = allSessions.map(s => {
      if (!Array.isArray(s.scores)) return 0
      const vals = s.scores.flatMap(q => Object.values(q).filter(v => typeof v === "number"))
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    })
    const overallAvg = allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length
    if (overallAvg >= 8.5) award("interview_god")
  }

  return { newBadges, awarded }
}

// ── STREAK ─────────────────────────────────────────────────────────────────────
function calculateStreak(lastActiveAt, currentStreak) {
  if (!lastActiveAt) return { newStreak: 1, isStreak: false }
  const now = new Date()
  const last = new Date(lastActiveAt)
  const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return { newStreak: currentStreak, isStreak: false }
  if (diffDays === 1) return { newStreak: currentStreak + 1, isStreak: true }
  return { newStreak: 1, isStreak: false }
}

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' })
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = decoded
    next()
  } catch (error) {
    res.status(403).json({ error: 'Invalid or expired token.' })
  }
}

// ── ROUTES ─────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ message: "Express server is running" }))
app.get("/status", (req, res) => res.json({ status: "ok", server: "interview-backend" }))
app.get("/info", (req, res) => res.json({ name: "Snigdha", college: "IEM", year: "3rd" }))

app.post("/submit", (req, res) => {
  const { name, message } = req.body
  if (!name || !message) return res.status(400).json({ error: "name and message are required" })
  res.json({ received: true, yourData: req.body })
})

app.post('/resume', async (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'text field is required' })
  const resume = await prisma.resume.create({ data: { text } })
  res.json({ received: true, id: resume.id, text: resume.text })
})

app.get('/resumes', async (req, res) => {
  const resumes = await prisma.resume.findMany()
  res.json(resumes)
})

app.delete('/resume/:id', async (req, res) => {
  await prisma.resume.delete({ where: { id: Number(req.params.id) } })
  res.json({ deleted: true })
})

app.post('/generate-questions', authenticateToken, async (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'resume text is required' })

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })
    const prompt = `You are an expert technical interviewer. Based on this resume, generate exactly 5 interview questions.

Return ONLY a JSON array of exactly 5 objects. No explanation, no markdown, just the raw array.
Each object must have exactly two fields:
- "question": the interview question string
- "category": one of "skillset", "education", "work", "hr", "coding"

Rules:
- Use "coding" ONLY for questions that require writing actual code
- If the resume has programming experience, include at least 1 "coding" question
- Cover at least 3 different categories total

Resume: ${text}`

    const result = await model.generateContent(prompt)
    const response = result.response.text()
    const cleaned = response.replace(/```json|```/g, "").trim()
    const questions = JSON.parse(cleaned)
    res.json({ questions })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to generate questions. Please try again.' })
  }
})

// ── EVALUATE ANSWER — 3 dimensions ────────────────────────────────────────────
app.post('/evaluate-answer', async (req, res) => {
  const { question, answer, category, background } = req.body
  // background = candidate background e.g. "3rd year BTech CSE student"

  if (!question || !answer) return res.status(400).json({ error: 'question and answer are required' })

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })
    const isCoding = category === "coding"
    const candidateContext = background
      ? `The candidate is a ${background}. Score them relative to what is reasonably expected from someone at that level — not against a senior engineer standard. A ${background} who demonstrates solid understanding of the concept, gives relevant examples, and shows clear thinking deserves 8-9. Reserve 10 for exceptional answers that go beyond expectations for their level.`
      : `Score relative to a typical student or early-career developer. Solid, clear, relevant answers should score 7-9. Reserve 10 for exceptional depth.`

    const prompt = isCoding
      ? `You are an expert software engineer evaluating a coding answer.

${candidateContext}

Question: ${question}
Code Answer: ${answer}

Evaluate on exactly these 3 dimensions:
1. Correctness — Does the code solve the problem correctly? Does it handle edge cases?
2. Code Quality — Is the code clean, readable, well-structured, good variable names?
3. Efficiency — Is the time/space complexity reasonable? Are there obvious optimizations missed?

Scoring guide:
- 9-10: Correct, clean, efficient. Handles edge cases. Exactly what you'd expect from a strong candidate at their level.
- 7-8: Mostly correct with minor issues. Readable. Reasonable approach.
- 5-6: Works for basic cases but misses edge cases or has quality issues.
- 3-4: Partially correct or has significant logic errors.
- 1-2: Incorrect or does not address the problem.

Return ONLY a JSON object, nothing else:
{
  "correctness": <1-10>,
  "codeQuality": <1-10>,
  "efficiency": <1-10>,
  "feedback": "<2-3 sentences about what was good and what was wrong>",
  "improvement": "<one specific actionable thing to improve>"
}`
      : `You are an expert technical interviewer evaluating a spoken/written interview answer.

${candidateContext}

Question: ${question}
Answer: ${answer}

Evaluate on exactly these 3 dimensions:
1. Technical Depth — How accurate and detailed is the technical knowledge shown? Does the candidate understand the concept, not just the surface?
2. Clarity — Is the answer well-structured, easy to follow, and to the point? Does it avoid rambling?
3. Confidence Tone — Does the answer sound assertive and sure? Or is it hesitant, vague, and full of "I think maybe"?

Scoring guide:
- 9-10: Strong on this dimension. Clearly exceeds typical expectation for their level.
- 7-8: Good. Demonstrates solid understanding or communication at the expected level.
- 5-6: Adequate but surface-level. Some gaps or unclear communication.
- 3-4: Weak. Misses key points or very unclear.
- 1-2: Very poor. Wrong, irrelevant, or almost no answer given.

Be fair but honest. Do not inflate scores. If an answer is genuinely good for someone at their level, reward it with 8-9.

Return ONLY a JSON object, nothing else:
{
  "technicalDepth": <1-10>,
  "clarity": <1-10>,
  "confidenceTone": <1-10>,
  "feedback": "<2-3 sentences — what was strong, what was weak>",
  "improvement": "<one specific actionable thing to improve>"
}`

    const result = await model.generateContent(prompt)
    const response = result.response.text()
    const cleaned = response.replace(/```json|```/g, "").trim()
    const evaluation = JSON.parse(cleaned)
    res.json(evaluation)

  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to evaluate answer. Please try again.' })
  }
})

app.post('/send-otp', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'email required' })
  try {
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) return res.status(400).json({ error: 'Email already registered' })
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await prisma.oTP.deleteMany({ where: { email } })
    await prisma.oTP.create({ data: { email, code, expiresAt } })
    await transporter.sendMail({
      from: process.env.GMAIL_USER, to: email,
      subject: 'Verify your email',
      html: `<h2>Your OTP is ${code}</h2>`
    })
    res.json({ message: 'OTP sent', email })
  } catch (err) {
    console.error("OTP ERROR 👉", err)
    res.status(500).json({ error: 'Failed to send OTP' })
  }
})

app.post('/verify-otp', async (req, res) => {
  const { email, code } = req.body
  const record = await prisma.oTP.findFirst({ where: { email, code } })
  if (!record) return res.status(400).json({ error: 'Invalid OTP' })
  if (new Date() > record.expiresAt) return res.status(400).json({ error: 'OTP expired' })
  await prisma.oTP.deleteMany({ where: { email } })
  res.json({ message: 'OTP verified' })
})

app.post('/complete-signup', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'email and password required' })
  try {
    const hashedPassword = await bcrypt.hash(password, 10)
    await prisma.user.create({ data: { email, password: hashedPassword, verified: true } })
    res.json({ message: 'Account created successfully' })
  } catch (err) {
    res.status(500).json({ error: 'Signup failed' })
  }
})

app.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' })
  try {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return res.status(401).json({ error: 'Invalid email or password' })
    const passwordMatch = await bcrypt.compare(password, user.password)
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid email or password' })
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )
    res.json({ token, userId: user.id, email: user.email })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Login failed' })
  }
})

// ── SAVE SESSION ───────────────────────────────────────────────────────────────
// scores is now an array: [{ category, technicalDepth, clarity, confidenceTone, feedback, improvement }, ...]
// or for coding: [{ category, correctness, codeQuality, efficiency, feedback, improvement }, ...]
app.post('/save-session', authenticateToken, async (req, res) => {
  const { role, background, scores, violations } = req.body
  if (!role || !scores) return res.status(400).json({ error: 'role and scores required' })

  try {
    const userId = String(req.user.userId)
    const user = await prisma.user.findUnique({ where: { id: userId } })
    const allSessions = await prisma.interviewSession.findMany({ where: { userId } })

    const { newStreak, isStreak } = calculateStreak(user.lastActiveAt, user.streak)
    const { total: xpEarned, breakdown } = calculateXP(scores, violations || {}, isStreak)
    const newXP = user.xp + xpEarned
    const newLevel = getLevelFromXP(newXP).level

    const updatedSessions = [...allSessions, { scores, violations: violations || {} }]
    const { newBadges, awarded } = await checkAndAwardBadges(
      userId, user.badges || [], updatedSessions, scores, newStreak
    )

    const session = await prisma.interviewSession.create({
      data: {
        userId,
        role,
        background: background || "",
        scores,       // array of per-question dimension scores
        violations: violations || {},
        xpEarned
      }
    })

    await prisma.user.update({
      where: { id: userId },
      data: { xp: newXP, level: newLevel, streak: newStreak, lastActiveAt: new Date(), badges: newBadges }
    })

    res.json({
      message: 'Session saved',
      session,
      xp: { earned: xpEarned, total: newXP, breakdown, levelUp: newLevel > user.level, newLevel: getLevelFromXP(newXP) },
      streak: { current: newStreak, isStreak },
      badges: { awarded, total: newBadges }
    })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to save session' })
  }
})

app.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await prisma.interviewSession.findMany({
      where: { userId: String(req.user.userId) },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ sessions })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch sessions' })
  }
})

app.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: String(req.user.userId) },
      select: { id: true, email: true, xp: true, level: true, streak: true, badges: true, lastActiveAt: true }
    })
    const levelInfo = getLevelFromXP(user.xp)
    const nextLevel = LEVELS.find(l => l.level === levelInfo.level + 1)
    res.json({
      ...user,
      levelInfo,
      nextLevel: nextLevel || null,
      xpToNext: nextLevel ? nextLevel.minXP - user.xp : 0,
      allBadges: Object.values(BADGES)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

app.listen(4000, () => console.log("Server running on port 4000"))

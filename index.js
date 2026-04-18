require('dotenv').config()
const express = require("express")
const cors = require("cors")
const app = express()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
app.use(cors())
app.use(express.json({ limit: '10mb' }))
const { GoogleGenerativeAI } = require("@google/generative-ai")
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const nodemailer = require('nodemailer')
const multer = require('multer')
const path = require('path')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
})

// ── GEMINI RETRY WRAPPER ──────────────────────────────────────────────────────
// fix 2: retry up to 3 times with exponential backoff on quota errors
async function geminiWithRetry(prompt, maxRetries = 3) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt)
      return result.response.text()
    } catch (err) {
      const isQuota = err?.message?.includes('429') ||
        err?.message?.includes('quota') ||
        err?.message?.includes('RESOURCE_EXHAUSTED') ||
        err?.status === 429

      if (isQuota && attempt < maxRetries) {
        // exponential backoff: 2s, 4s, 8s
        const waitMs = Math.pow(2, attempt) * 1000
        console.log(`Gemini quota hit — retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})`)
        await new Promise(res => setTimeout(res, waitMs))
        continue
      }

      // not a quota error or out of retries
      throw err
    }
  }
}

// ── BADGE DEFINITIONS ─────────────────────────────────────────────────────────
const BADGES = {
  FIRST_BLOOD:   { id: "first_blood",   label: "First Blood",   icon: "🎯", desc: "Complete your first session" },
  ON_FIRE:       { id: "on_fire",        label: "On Fire",       icon: "🔥", desc: "7 day streak" },
  CODE_WARRIOR:  { id: "code_warrior",   label: "Code Warrior",  icon: "💻", desc: "Coding correctness 8+ in 3 sessions" },
  BIG_BRAIN:     { id: "big_brain",      label: "Big Brain",     icon: "🧠", desc: "All dimension avgs 8+ in one session" },
  CLEAN_RECORD:  { id: "clean_record",   label: "Clean Record",  icon: "👁️", desc: "5 sessions with zero violations" },
  GRINDER:       { id: "grinder",        label: "Grinder",       icon: "🚀", desc: "Complete 10 sessions" },
  INTERVIEW_GOD: { id: "interview_god",  label: "Interview God", icon: "👑", desc: "Overall avg 8.5+ across 10 sessions" },
  VOICE_MASTER:  { id: "voice_master",   label: "Voice Master",  icon: "🎤", desc: "Complete 3 voice conversation interviews" },
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

function calculateXP(scores, violations, isStreak) {
  const breakdown = []
  let total = 0
  total += 50
  breakdown.push({ reason: "Session completed", xp: 50 })
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
  if (isStreak) { total += 30; breakdown.push({ reason: "Daily streak", xp: 30 }) }
  const totalViolations = (violations.tabSwitch || 0) + (violations.faceAway || 0) + (violations.multipleFaces || 0)
  if (!violations.terminated && totalViolations === 0) {
    total += 25; breakdown.push({ reason: "Zero violations", xp: 25 })
  }
  if (violations.terminated) {
    total = Math.max(0, total - 30)
    breakdown.push({ reason: "Session terminated penalty", xp: -30 })
  }
  return { total, breakdown }
}

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
  const cleanSessions = allSessions.filter(s => {
    const v = s.violations || {}
    return !v.terminated && (v.tabSwitch || 0) + (v.faceAway || 0) + (v.multipleFaces || 0) === 0
  })
  if (cleanSessions.length >= 5) award("clean_record")
  const allHigh = scores.every(s => {
    const vals = Object.values(s).filter(v => v != null && typeof v === "number")
    return vals.length > 0 && vals.reduce((a, b) => a + b, 0) / vals.length >= 8
  })
  if (allHigh) award("big_brain")
  const codingHighSessions = allSessions.filter(s =>
    Array.isArray(s.scores) && s.scores.some(q => q.category === "coding" && (q.correctness || 0) >= 8)
  ).length
  if (codingHighSessions >= 3) award("code_warrior")
  if (allSessions.length >= 10) {
    const allAvgs = allSessions.map(s => {
      if (!Array.isArray(s.scores)) return 0
      const vals = s.scores.flatMap(q => Object.values(q).filter(v => typeof v === "number"))
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    })
    const overallAvg = allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length
    if (overallAvg >= 8.5) award("interview_god")
  }
  // voice master badge
  const voiceSessions = allSessions.filter(s => s.isVoiceMode).length
  if (voiceSessions >= 3) award("voice_master")
  return { newBadges, awarded }
}

function calculateStreak(lastActiveAt, currentStreak) {
  if (!lastActiveAt) return { newStreak: 1, isStreak: false }
  const now = new Date()
  const last = new Date(lastActiveAt)
  const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return { newStreak: currentStreak, isStreak: false }
  if (diffDays === 1) return { newStreak: currentStreak + 1, isStreak: true }
  return { newStreak: 1, isStreak: false }
}

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

// ── RESUME EXTRACTION ─────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.doc', '.txt', '.png', '.jpg', '.jpeg']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) cb(null, true)
    else cb(new Error('File type not supported'))
  }
})

app.post('/extract-resume', authenticateToken, upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const ext = path.extname(req.file.originalname).toLowerCase()
  let text = ''
  try {
    if (ext === '.txt') {
      text = req.file.buffer.toString('utf-8')
    } else if (ext === '.pdf') {
      const pdfParse = require('pdf-parse')
      const data = await pdfParse(req.file.buffer)
      text = data.text
    } else if (ext === '.docx' || ext === '.doc') {
      const mammoth = require('mammoth')
      const result = await mammoth.extractRawText({ buffer: req.file.buffer })
      text = result.value
    } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
      const Tesseract = require('tesseract.js')
      const { data: { text: ocrText } } = await Tesseract.recognize(req.file.buffer, 'eng')
      text = ocrText
    }
    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract enough text. Please paste your resume manually.' })
    }
    res.json({ text: text.trim() })
  } catch (err) {
    console.error('Resume extraction error:', err)
    res.status(500).json({ error: 'Failed to extract text. Please paste your resume manually.' })
  }
})

// ── STANDARD ROUTES ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ message: "InterviewPrep API running" }))
app.get("/status", (req, res) => res.json({ status: "ok" }))

app.post('/generate-questions', authenticateToken, async (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'resume text is required' })
  try {
    const prompt = `You are an expert technical interviewer. Based on this resume, generate exactly 5 interview questions.
Return ONLY a JSON array of exactly 5 objects. No explanation, no markdown, just the raw array.
Each object must have exactly two fields:
- "question": the interview question string
- "category": one of "skillset", "education", "work", "hr", "coding"
Rules:
- Use "coding" ONLY for questions that require writing actual code
- If the resume has programming experience, include at least 1 coding question
- Cover at least 3 different categories total
Resume: ${text}`

    const raw = await geminiWithRetry(prompt)
    const cleaned = raw.replace(/```json|```/g, "").trim()
    const questions = JSON.parse(cleaned)
    res.json({ questions })
  } catch (error) {
    console.error(error)
    // fix 2: user-friendly quota error message
    if (error?.message?.includes('429') || error?.message?.includes('quota') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({ error: 'AI service is busy right now. Please wait 30 seconds and try again.' })
    }
    res.status(500).json({ error: 'Failed to generate questions. Please try again.' })
  }
})

app.post('/evaluate-answer', async (req, res) => {
  const { question, answer, category, background } = req.body
  if (!question || !answer) return res.status(400).json({ error: 'question and answer are required' })
  try {
    const isCoding = category === "coding"
    const candidateContext = background
      ? `The candidate is a ${background}. Score relative to what is expected at that level — not a senior engineer standard. A ${background} who demonstrates solid understanding deserves 8-9. Reserve 10 for exceptional answers beyond expectations for their level.`
      : `Score relative to a student or early-career developer. Solid answers should score 7-9.`

    const prompt = isCoding
      ? `You are an expert software engineer evaluating a coding answer.
${candidateContext}
Question: ${question}
Code: ${answer}
Return ONLY a JSON object:
{"correctness":<1-10>,"codeQuality":<1-10>,"efficiency":<1-10>,"feedback":"<2-3 sentences>","improvement":"<one thing>"}`
      : `You are an expert technical interviewer evaluating an answer.
${candidateContext}
Question: ${question}
Answer: ${answer}
Evaluate: Technical Depth (knowledge accuracy), Clarity (structure), Confidence Tone (assertiveness).
Scoring: 9-10 exceeds level expectation. 7-8 solid. 5-6 surface-level. 3-4 weak. 1-2 very poor.
Return ONLY a JSON object:
{"technicalDepth":<1-10>,"clarity":<1-10>,"confidenceTone":<1-10>,"feedback":"<2-3 sentences>","improvement":"<one thing>"}`

    const raw = await geminiWithRetry(prompt)
    const cleaned = raw.replace(/```json|```/g, "").trim()
    const evaluation = JSON.parse(cleaned)
    res.json(evaluation)
  } catch (error) {
    console.error(error)
    if (error?.message?.includes('429') || error?.message?.includes('quota') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({ error: 'AI service is busy. Please wait 30 seconds and try again.' })
    }
    res.status(500).json({ error: 'Failed to evaluate answer. Please try again.' })
  }
})

// ── VOICE CONVERSATION INTERVIEW ──────────────────────────────────────────────
// This is the standout feature — real-time AI interviewer conversation
// Frontend sends: { message, conversationHistory, resume, role, background, questionCount }
// Backend responds with: { reply, isQuestion, questionNumber, isComplete }
app.post('/voice-interview', authenticateToken, async (req, res) => {
  const { message, conversationHistory = [], resume, role, background, questionCount = 0 } = req.body

  try {
    const maxQuestions = 5
    const isFirstMessage = conversationHistory.length === 0
    const historyText = conversationHistory
      .slice(-4) // only last 4 messages to save tokens
      .map(h => `${h.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${h.content}`)
      .join('\n')

    // shortened prompt — fewer tokens = less quota pressure
    const prompt = `You are a technical interviewer. Ask ${maxQuestions} questions total about the candidate's resume. Be brief and conversational.
Role: ${role || 'Software Developer'}
Background: ${background || 'Student'}
Resume (brief): ${resume ? resume.substring(0, 300) : 'Not provided'}
Questions asked so far: ${questionCount}/${maxQuestions}
${historyText ? `Recent conversation:\n${historyText}` : ''}
${isFirstMessage ? 'Greet briefly and ask question 1.' : `Candidate said: "${message}"\nGive one sentence of feedback then ${questionCount >= maxQuestions ? 'close the interview professionally and end with INTERVIEW_COMPLETE' : 'ask the next question'}.`}
Keep response under 3 sentences.`

    const raw = await geminiWithRetry(prompt, 3)
    const reply = raw.trim()
    const isComplete = reply.includes("INTERVIEW_COMPLETE")
    const cleanReply = reply.replace("INTERVIEW_COMPLETE", "").trim()
    const isQuestion = cleanReply.includes("?") && !isComplete

    res.json({
      reply: cleanReply,
      isQuestion,
      isComplete,
      questionNumber: isQuestion ? questionCount + 1 : questionCount,
    })

  } catch (error) {
    console.error(error)
    if (error?.message?.includes('429') || error?.message?.includes('quota') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({ error: 'AI is busy. Retrying in 30 seconds automatically.' })
    }
    res.status(500).json({ error: 'Failed to get AI response. Please try again.' })
  }
})

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
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
      subject: 'Your InterviewPrep OTP',
      html: `<div style="font-family:Arial;max-width:400px;margin:0 auto;padding:24px;background:#0d1117;color:#fff;border-radius:12px">
        <h2 style="color:#22c55e">InterviewPrep</h2>
        <p>Your verification code is:</p>
        <h1 style="color:#22c55e;letter-spacing:8px;font-size:36px">${code}</h1>
        <p style="color:#6b7280;font-size:12px">Expires in 10 minutes</p>
      </div>`
    })
    res.json({ message: 'OTP sent', email })
  } catch (err) {
    console.error("OTP ERROR:", err)
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
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, userId: user.id, email: user.email })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Login failed' })
  }
})

// ── SESSION ROUTES ────────────────────────────────────────────────────────────
app.post('/save-session', authenticateToken, async (req, res) => {
  const { role, background, scores, violations, isVoiceMode } = req.body
  if (!role || !scores) return res.status(400).json({ error: 'role and scores required' })
  try {
    const userId = String(req.user.userId)
    const user = await prisma.user.findUnique({ where: { id: userId } })
    const allSessions = await prisma.interviewSession.findMany({ where: { userId } })
    const { newStreak, isStreak } = calculateStreak(user.lastActiveAt, user.streak)
    const { total: xpEarned, breakdown } = calculateXP(scores, violations || {}, isStreak)
    const newXP = user.xp + xpEarned
    const newLevel = getLevelFromXP(newXP).level
    const updatedSessions = [...allSessions, { scores, violations: violations || {}, isVoiceMode }]
    const { newBadges, awarded } = await checkAndAwardBadges(userId, user.badges || [], updatedSessions, scores, newStreak)
    const session = await prisma.interviewSession.create({
      data: { userId, role, background: background || "", scores, violations: violations || {}, xpEarned, isVoiceMode: isVoiceMode || false }
    })
    await prisma.user.update({
      where: { id: userId },
      data: { xp: newXP, level: newLevel, streak: newStreak, lastActiveAt: new Date(), badges: newBadges }
    })
    res.json({
      message: 'Session saved', session,
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
      ...user, levelInfo,
      nextLevel: nextLevel || null,
      xpToNext: nextLevel ? nextLevel.minXP - user.xp : 0,
      allBadges: Object.values(BADGES)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))

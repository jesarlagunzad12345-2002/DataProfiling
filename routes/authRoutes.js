const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).render('login', {
      title: 'Sign in',
      errorMessage: 'Too many sign-in attempts. Please wait a few minutes and try again.',
      loginValue: ''
    });
  }
});

router.get('/login', authController.getLoginPage);
router.post('/login', loginLimiter, authController.postLogin);
router.get('/forgot-password', authController.getForgotPassword);
router.post('/logout', authController.postLogout);

module.exports = router;
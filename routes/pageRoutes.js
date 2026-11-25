const express = require('express');
const { requireAuthentication } = require('../middleware/auth');
const dashboardController = require('../controllers/dashboardController');

const router = express.Router();

router.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard' : '/login');
});
router.get('/dashboard', requireAuthentication, dashboardController.getDashboard);

module.exports = router;
function requireAuthentication(req, res, next) {
  if (req.session && req.session.user) {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    return next();
  }

  if (req.method === 'GET' && req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//')) {
    req.session.returnTo = req.originalUrl;
  }
  res.redirect('/login');
}

module.exports = { requireAuthentication };
const router = require('express').Router();
const webhookAuth = require('../middleware/webhookAuth');
const c = require('../controllers/webhook.controller');

// POST /webhooks/:instanceRef — recebe eventos da Evolution
router.post('/:instanceRef', webhookAuth, c.receberEvento);

module.exports = router;

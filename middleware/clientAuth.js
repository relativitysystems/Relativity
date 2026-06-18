const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

module.exports = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { data: clientUser, error: cuError } = await supabase
    .from('client_users')
    .select('client_id, email')
    .eq('auth_user_id', user.id)
    .single();

  if (cuError || !clientUser) {
    return res.status(401).json({ error: 'No client account found for this user' });
  }

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id, name, email, slack_channel_id, dropbox_watch_path, is_active')
    .eq('id', clientUser.client_id)
    .single();

  if (clientError || !client) {
    return res.status(401).json({ error: 'Client record not found' });
  }

  if (!client.is_active) {
    return res.status(403).json({ error: 'Account is not active' });
  }

  const { data: member, error: memberError } = await supabase
    .from('client_members')
    .select('id, role, status, full_name')
    .eq('auth_user_id', user.id)
    .eq('client_id', client.id)
    .single();

  if (memberError || !member) {
    return res.status(401).json({ error: 'No team member record found for this user' });
  }

  if (member.status === 'disabled' || member.status === 'revoked') {
    return res.status(403).json({ error: 'Account is disabled' });
  }

  req.user = { id: user.id, email: clientUser.email };
  req.client = client;
  req.member = member;
  next();
};

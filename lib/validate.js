const { err } = require('./errors');

// Tiny dependency-free validator: declarative schema → sanitized values or 422.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const V = {
  string: (o = {}) => ({ type: 'string', ...o }),
  int: (o = {}) => ({ type: 'int', ...o }),
  number: (o = {}) => ({ type: 'number', ...o }),
  bool: (o = {}) => ({ type: 'bool', ...o }),
  enum: (values, o = {}) => ({ type: 'enum', values, ...o }),
  email: (o = {}) => ({ type: 'email', ...o }),
  username: (o = {}) => ({ type: 'username', ...o }),
  password: (o = {}) => ({ type: 'password', ...o }),
  array: (o = {}) => ({ type: 'array', ...o }),
  object: (o = {}) => ({ type: 'object', ...o }),
  color: (o = {}) => ({ type: 'color', ...o })
};

function coerce(key, rule, value, errors) {
  const missing = value === undefined || value === null || value === '';
  if (missing) {
    if (rule.required) errors.push({ field: key, message: `${key} is required` });
    return rule.default !== undefined ? rule.default : undefined;
  }

  switch (rule.type) {
    case 'string': {
      let v = String(value);
      if (rule.trim !== false) v = v.trim();
      if (rule.min && v.length < rule.min) errors.push({ field: key, message: `${key} must be at least ${rule.min} characters` });
      if (rule.max && v.length > rule.max) v = v.slice(0, rule.max);
      if (rule.pattern && !rule.pattern.test(v)) errors.push({ field: key, message: rule.message || `${key} has an invalid format` });
      return v;
    }
    case 'email': {
      const v = String(value).trim().toLowerCase();
      if (!EMAIL_RE.test(v)) errors.push({ field: key, message: 'Enter a valid email address' });
      return v;
    }
    case 'username': {
      const v = String(value).trim();
      if (!USERNAME_RE.test(v)) errors.push({ field: key, message: 'Username must be 3–32 characters (letters, numbers, . _ -)' });
      return v;
    }
    case 'password': {
      const v = String(value);
      const min = rule.min || 8;
      if (v.length < min) errors.push({ field: key, message: `Password must be at least ${min} characters` });
      if (v.length > 200) errors.push({ field: key, message: 'Password is too long' });
      return v;
    }
    case 'int': {
      const v = parseInt(value, 10);
      if (isNaN(v)) { errors.push({ field: key, message: `${key} must be a whole number` }); return undefined; }
      if (rule.min !== undefined && v < rule.min) return rule.clamp === false ? (errors.push({ field: key, message: `${key} must be ≥ ${rule.min}` }), v) : rule.min;
      if (rule.max !== undefined && v > rule.max) return rule.clamp === false ? (errors.push({ field: key, message: `${key} must be ≤ ${rule.max}` }), v) : rule.max;
      return v;
    }
    case 'number': {
      const v = parseFloat(value);
      if (isNaN(v)) { errors.push({ field: key, message: `${key} must be a number` }); return undefined; }
      if (rule.min !== undefined && v < rule.min) return rule.min;
      if (rule.max !== undefined && v > rule.max) return rule.max;
      return v;
    }
    case 'bool':
      if (typeof value === 'boolean') return value;
      return value === 'true' || value === '1' || value === 1;
    case 'enum': {
      const v = String(value);
      if (!rule.values.includes(v)) { errors.push({ field: key, message: `${key} must be one of: ${rule.values.join(', ')}` }); return undefined; }
      return v;
    }
    case 'color': {
      const v = String(value).trim();
      if (!HEX_RE.test(v)) { errors.push({ field: key, message: `${key} must be a hex color like #8ba4ff` }); return undefined; }
      return v;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push({ field: key, message: `${key} must be an array` }); return undefined; }
      if (rule.max && value.length > rule.max) return value.slice(0, rule.max);
      return value;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) { errors.push({ field: key, message: `${key} must be an object` }); return undefined; }
      return value;
    }
    default:
      return value;
  }
}

// Validate a source object against a schema. Returns cleaned data or throws 422.
function check(source, schema) {
  const errors = [];
  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    const v = coerce(key, rule, source ? source[key] : undefined, errors);
    if (v !== undefined) out[key] = v;
  }
  if (errors.length) throw err.validation('Please correct the highlighted fields', errors);
  return out;
}

const body = schema => (req, res, next) => {
  try { req.data = check(req.body || {}, schema); next(); } catch (e) { next(e); }
};
const query = schema => (req, res, next) => {
  try { req.q = check(req.query || {}, schema); next(); } catch (e) { next(e); }
};

module.exports = { V, check, body, query, EMAIL_RE, USERNAME_RE };

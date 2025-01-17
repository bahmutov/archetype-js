'use strict';

const Schema = require('../').Schema;
const StandardError = require('standard-error');
const ValidateError = require('./error');
const _ = require('lodash');
const applyDefaults = require('../defaults');
const checkRequired = require('../required');
const debug = require('debug')('archetype:umarshal');
const handleCast = require('./util').handleCast;
const inspect = require('util').inspect;
const join = require('./util').join;
const mpath = require('mpath');
const realPathToSchemaPath = require('./util').realPathToSchemaPath;
const shouldSkipPath = require('../util').shouldSkipPath;

module.exports = castDocument;

function markSubpaths(projection, path, val) {
  const pieces = path.split('.');
  let cur = pieces[0];
  projection[cur] = val;
  for (let i = 1; i < pieces.length; ++i) {
    cur += `.${pieces[i]}`;
    projection[cur] = val;
  }
}

function handleProjection(projection) {
  if (!projection) {
    return { $inclusive: true };
  }
  projection = _.cloneDeep(projection);
  let inclusive = null;
  for (const key of Object.keys(projection)) {
    if (key.startsWith('$')) {
      continue;
    }
    if (projection[key] > 0) {
      if (inclusive === true) {
        throw new Error("Can't mix inclusive and exclusive in projection");
      }
      markSubpaths(projection, key, projection[key]);
      inclusive = false;
    } else {
      if (inclusive === false) {
        throw new Error("Can't mix inclusive and exclusive in projection");
      }
      inclusive = true;
    }
  }

  if (inclusive === null) {
    inclusive = true;
  }
  projection.$inclusive = inclusive;
  return projection;
}

function castDocument(obj, schema, projection) {
  projection = handleProjection(projection);
  if (obj == null) {
    throw new Error(`Can't cast null or undefined`);
  }
  applyDefaults(obj, schema, projection);
  const error = new ValidateError();
  error.merge(visitObject(obj, schema, projection, '').error);
  error.merge(checkRequired(obj, schema, projection));
  error.merge(runValidation(obj, schema, projection));
  if (error.hasError) {
    throw error;
  }
  return obj;
}

function visitArray(arr, schema, projection, path) {
  debug('visitArray', arr, path, schema);
  let error = new ValidateError();
  let curPath = realPathToSchemaPath(path);
  let newPath = join(curPath, '$');
  if (!schema._paths[newPath] || !schema._paths[newPath].$type) {
    debug('skipping', newPath);
    return {
      value: arr,
      error: null
    };
  }

  if (arr == null) {
    return {
      value: arr,
      error: null
    };
  }

  if (!Array.isArray(arr)) {
    arr = [arr];
  }

  debug('newPath', newPath, schema._paths[newPath].$type);
  arr.forEach(function(value, index) {
    if (schema._paths[newPath].$type === Array ||
        Array.isArray(schema._paths[newPath].$type)) {
      let res = visitArray(value, schema, projection, join(path, index, true));
      if (res.error) {
        error.merge(res.error);
      }
      arr[index] = res.value;
      return;
    } else if (schema._paths[newPath].$type === Object) {
      let res = visitObject(value, schema, projection, join(path, index, true));
      if (res.error) {
        error.merge(res.error);
      }
      arr[index] = res.value;
      return;
    }

    try {
      handleCast(arr, index, schema._paths[newPath].$type);
    } catch(err) {
      error.markError(join(path, index, true), err);
    }
  });

  return {
    value: arr,
    error: (error.hasError ? error : null)
  };
}

function visitObject(obj, schema, projection, path) {
  debug('visitObject', obj, schema, projection, path);
  let error = new ValidateError();
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    let err = new Error('Could not cast ' + require('util').inspect(obj) +
      ' to Object');
    error.markError(path, err);
    return {
      value: null,
      error: error
    };
  }

  let fakePath = realPathToSchemaPath(path);
  debug('fakePath', fakePath, obj);
  const curSchema = schema._paths[fakePath];
  if (fakePath && !curSchema.$schema) {
    return {
      value: obj,
      error: (error.hasError ? error : null)
    };
  }

  _.each(obj, function(value, key) {
    let newPath = join(fakePath, key);
    debug('visit', key);
    if (!schema._paths[newPath] || shouldSkipPath(projection, newPath)) {
      delete obj[key];
      return;
    }
    const newSchema = schema._paths[newPath];
    if (newSchema.$type == null) {
      // If type not specified, no type casting
      return;
    }

    if (schema._paths[newPath].$type === Array ||
        Array.isArray(schema._paths[newPath].$type)) {
      let res = visitArray(value, schema, projection, newPath);
      if (res.error) {
        debug('merge', res.error.errors);
        error.merge(res.error);
      }
      obj[key] = res.value;
      return;
    } else if (schema._paths[newPath].$type === Object) {
      if (value == null) {
        delete obj[key];
        return;
      }
      let res = visitObject(value, schema, projection, newPath);
      if (res.error) {
        debug('merge', res.error.errors);
        error.merge(res.error);
      }
      obj[key] = res.value;
      return;
    }

    try {
      handleCast(obj, key, schema._paths[newPath].$type);
    } catch(err) {
      error.markError(join(path, key, true), err);
    }
  });

  return {
    value: obj,
    error: (error.hasError ? error : null)
  };
}

function runValidation(obj, schema, projection) {
  const error = new ValidateError();
  _.each(Object.keys(schema._paths), path => {
    debug(`Checking validation for "${path}"`);
    if (shouldSkipPath(projection, path)) {
      debug(`Skip validation for "${path}"`);
      return;
    }

    const _path = path.replace(/\.\$\./g, '.').replace(/\.\$$/g, '');
    const val = mpath.get(_path, obj);

    if (!schema._paths[path].$validate && !schema._paths[path].$enum) {
      debug(`No validation for "${path}"`);
      return true;
    }

    if (val == null) {
      return;
    }

    if (Array.isArray(schema._paths[path].$enum)) {
      if (Array.isArray(val)) {
        _.each(val, (val, index) => {
          if (schema._paths[path].$enum.indexOf(val) === -1) {
            const msg = `Value "${val}" invalid, allowed values are ` +
              `"${inspect(schema._paths[path].$enum)}"`;
            error.markError([path, index].join('.'), new Error(msg));
            return;
          }
        });
      } else {
        if (schema._paths[path].$enum.indexOf(val) === -1) {
          const msg = `Value "${val}" invalid, allowed values are ` +
            `"${inspect(schema._paths[path].$enum)}"`;
          error.markError(path, new Error(msg));
          return;
        }
      }
    }

    if (schema._paths[path].$validate) {
      if (Array.isArray(val)) {
        if (path.indexOf('$') === -1) {
          debug(`Path "${path}" is plain array`);
          try {
            schema._paths[path].$validate(val, schema._paths[path], obj);
          } catch(_error) {
            error.markError(path, _error);
          }
        } else {
          debug(`Validate each element for "${path}"`);
          _.each(val, (val, index) => {
            try {
              schema._paths[path].$validate(val, schema._paths[path], obj);
            } catch(_error) {
              error.markError(`${path}.${index}`, _error);
            }
          });
        }
      } else {
        try {
          schema._paths[path].$validate(val, schema._paths[path], obj);
        } catch(_error) {
          error.markError(path, _error);
        }
      }
    }
  });
  return error;
}

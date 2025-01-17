'use strict';

const _ = require('lodash');
const unmarshal = require('./unmarshal');

class Archetype {
  constructor(obj) {
    this._obj = _.cloneDeep(obj);
    this._paths = {};
  }

  compile(name) {
    const _this = this;
    this._paths = visitor(this._obj);
    const type = function(obj, projection) {
      if (!(this instanceof type)) {
        return new type(obj, projection);
      }
      Object.assign(this, unmarshal(_.cloneDeep(obj), _this, projection));
    };
    type.schema = this;
    if (name) {
      type.toString = () => name;
      Object.defineProperty(type, 'name', { value: name });
    }
    type.paths = () => this.paths();

    type.path = (path, props) => this.path(path, props);
    type.omit = path => this.omit(path);
    type.pick = paths => this.pick(paths);
    type.transform = fn => this.transform(fn);

    return type;
  }

  json() {
    return this._obj;
  }

  path(path, props) {
    if (!props) {
      return _.get(this._obj, path);
    }
    const newSchema = new Archetype(this._obj);
    _.set(newSchema._obj, path, props);
    return newSchema;
  }

  omit(path) {
    const newSchema = new Archetype(this._obj);
    _.unset(newSchema._obj, path);
    return newSchema;
  }

  pick(paths) {
    const newSchema = new Archetype(_.pick(this._obj, paths));
    return newSchema;
  }

  transform(fn) {
    const newSchema = new Archetype(this._obj);
    _.each(Object.keys(newSchema._obj), key => {
      newSchema._obj[key] = fn(key, newSchema._obj[key]);
    });
    return newSchema;
  }

  paths() {
    return _.map(Object.keys(this._paths),
      path => Object.assign({}, this._paths[path], { path }));
  }

  unmarshal(obj, projection) {
    return unmarshal(obj, this, projection);
  }
}

function visitor(obj) {
  var paths = paths || {};

  visitObject(obj, '', paths);
  return paths;
}

function visitArray(arr, path, paths) {
  paths[path] = { $type: Array };
  if (arr.length > 0) {
    if (Array.isArray(arr[0])) {
      visitArray(arr[0], path + '.$', paths);
    } else if (typeof arr[0] === 'object') {
      visitObject(arr[0], path + '.$', paths);
    } else {
      paths[path + '.$'] = { $type: arr[0] };
    }
  } else {
    paths[path + '.$'] = { $type: null };
  }
  return paths[path];
}

function visitObject(obj, path, paths) {
  if ('$type' in obj) {
    if (Array.isArray(obj.$type)) {
      visitArray(obj.$type, path, paths);
      Object.assign(paths[path], _.omit(obj, '$type'));
      return;
    }
    paths[path] = obj;
    return;
  }

  if (path) {
    paths[path] = { $type: Object, $schema: obj };
  }
  _.each(obj, function(value, key) {
    if (Array.isArray(value)) {
      visitArray(value, join(path, key), paths);
    } else if (typeof value === 'object') {
      visitObject(value, join(path, key), paths);
    } else {
      paths[join(path, key)] = { $type: value };
    }
  });
}

function join(path, key) {
  if (path) {
    return path + '.' + key;
  }
  return key;
}

exports.Archetype = Archetype;

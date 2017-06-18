/*!
 * file-to-tar | MIT (c) Shinnosuke Watanabe
 * https://github.com/shinnn/file-to-tar
*/
'use strict';

const path = require('path');
const lstat = require('fs').lstat;

const basename = path.basename;
const dirname = path.dirname;
const resolve = path.resolve;

const appendType = require('append-type');
const fs = require('graceful-fs');
const isPlainObj = require('is-plain-obj');
const isStream = require('is-stream');
const mkdirp = require('mkdirp');
const Observable = require('zen-observable');
const pack = require('tar-fs').pack;
const cancelablePump = require('cancelable-pump');
const streamLib = require('stream');

const PassThrough = streamLib.PassThrough;
const Transform = streamLib.Transform;

const FILE_PATH_ERROR = 'Expected a file path to be compressed as an archive';
const TAR_PATH_ERROR = 'Expected a file path where an archive file will be created';
const TAR_TRANSFORM_ERROR = '`tarTransform` option must be a transform stream ' +
                          'that modifies the tar archive before writing';
const MAP_STREAM_ERROR = 'The function passed to `mapStream` option must return a stream';

const unsupportedOptions = [
  'entries',
  'filter',
  'ignore',
  'strip'
];

module.exports = function fileToTar(filePath, tarPath, options) {
  return new Observable(observer => {
    if (typeof filePath !== 'string') {
      throw new TypeError(`${FILE_PATH_ERROR}, but got ${appendType(filePath)}.`);
    }

    if (filePath.length === 0) {
      throw new Error(`${FILE_PATH_ERROR}, but got '' (empty string).`);
    }

    if (typeof tarPath !== 'string') {
      throw new TypeError(`${TAR_PATH_ERROR}, but got ${appendType(tarPath)}.`);
    }

    if (tarPath.length === 0) {
      throw new Error(`${TAR_PATH_ERROR}, but got '' (empty string).`);
    }

    const absoluteFilePath = resolve(filePath);
    const absoluteTarPath = resolve(tarPath);
    const dirPath = dirname(absoluteFilePath);

    if (absoluteFilePath === absoluteTarPath) {
      throw new Error(`Source file path must be different from the archive path. Both were specified to ${
        absoluteFilePath
      }.`);
    }

    if (options !== undefined) {
      if (!isPlainObj(options)) {
        throw new TypeError(`Expected a plain object to set file-to-tar options, but got ${appendType(options)}.`);
      }
    } else {
      options = {};
    }

    for (const optionName of unsupportedOptions) {
      const val = options[optionName];

      if (val !== undefined) {
        throw new Error(`file-to-tar doesn't support \`${optionName}\` option, but ${appendType(val)} was provided.`);
      }
    }

    if (options.tarTransform !== undefined) {
      if (!isStream(options.tarTransform)) {
        throw new TypeError(`${TAR_TRANSFORM_ERROR}, but got a non-stream value ${appendType(options.tarTransform)}.`);
      }

      if (!isStream.transform(options.tarTransform)) {
        throw new TypeError(`${TAR_TRANSFORM_ERROR}, but got a ${
          ['duplex', 'writable', 'readable'].find(type => isStream[type](options.tarTransform))
        } stream instead.`);
      }
    }

    let cancel;

    lstat(absoluteFilePath, (lstatErr, stat) => {
      if (lstatErr) {
        observer.error(lstatErr);
        return;
      }

      if (!stat.isFile()) {
        observer.error(new Error(`Expected ${absoluteFilePath} to be a file path, but it was a ${
          stat.isDirectory() ? 'directory' : 'symbolic link'
        }.`));

        return;
      }

      let firstWriteFailed = false;

      const firstWriteStream = fs.createWriteStream(tarPath, options).on('error', err => {
        if (err.code === 'EISDIR') {
          err.message = `Tried to write an archive file to ${absoluteTarPath}, but a directory already exists there.`;
          observer.error(err);

          return;
        }

        firstWriteFailed = true;
      });

      mkdirp(dirname(tarPath), Object.assign({fs}, options), mkdirpErr => {
        if (mkdirpErr) {
          observer.error(mkdirpErr);
          return;
        }

        const packStream = pack(dirPath, Object.assign({fs}, options, {
          entries: [basename(filePath)],
          map(header) {
            if (options.map) {
              header = options.map(header);
            }

            return header;
          },
          mapStream(fileStream, header) {
            const newStream = options.mapStream ? options.mapStream(fileStream, header) : fileStream;

            if (!isStream.readable(newStream)) {
              packStream.emit('error', new TypeError(`${MAP_STREAM_ERROR}${
                isStream(newStream) ?
                  ' that is readable, but returned a non-readable stream' :
                  `, but returned a non-stream value ${appendType(newStream)}`
              }.`));

              return new PassThrough();
            }

            let bytes = 0;

            observer.next({bytes, header});

            return newStream.pipe(new Transform({
              transform(chunk, encoding, cb) {
                bytes += chunk.length;

                observer.next({bytes, header});
                cb(null, chunk);
              }
            }));
          }
        }));

        function getDest() {
          return firstWriteFailed ? fs.createWriteStream(tarPath, options) : firstWriteStream;
        }

        cancel = cancelablePump(options.tarTransform ? [
          packStream,
          options.tarTransform,
          getDest()
        ] : [
          packStream,
          getDest()
        ], err => {
          if (err) {
            observer.error(err);
            return;
          }

          observer.complete();
        });
      });
    });

    return function cancelCompression() {
      if (cancel) {
        cancel();
      }
    };
  });
};
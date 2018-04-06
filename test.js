'use strict';

const {createGzip} = require('zlib');
const {join} = require('path');
const {promisify} = require('util');

const enumerateFiles = require('enumerate-files');
const {extract} = require('tar');
const fileToTar = require('.');
const mkdirp = require('mkdirp');
const rmfr = require('rmfr');
const {symlink} = require('graceful-fs');
const test = require('tape');

const promisifiedMkdirp = promisify(mkdirp);
const promisifiedSymlink = promisify(symlink);

test('fileToTar()', async t => {
	t.plan(21);

	const tmp = join(__dirname, 'tmp');
	const tmpSymlink = join(__dirname, 'tmp-symlink');
	const dest = join(tmp, 'archive.tar');

	await Promise.all([rmfr(tmp), rmfr(tmpSymlink)]);
	await promisifiedSymlink(__filename, tmpSymlink);

	fileToTar(join(__dirname, 'index.js'), dest).subscribe({
		next(progress) {
			if (progress.bytes === 0) {
				t.equal(
					progress.header.name,
					'index.js',
					'should send compression progress.'
				);

				return;
			}

			if (progress.bytes === progress.header.size) {
				t.ok(
					Number.isSafeInteger(progress.header.mode),
					'should send file metadata.'
				);
			}
		},
		error: t.fail,
		async complete() {
			const cwd = join(tmp, '0');

			await promisifiedMkdirp(cwd);
			await extract({file: dest, cwd});

			t.deepEqual(
				[...await enumerateFiles(cwd)],
				[join(cwd, 'index.js')],
				'should create a tar archive.'
			);
		}
	});

	const anotherDest = join(tmp, 'another-archive.tgz');

	fileToTar(join(__filename), anotherDest, {
		tarTransform: createGzip(),
		map(header) {
			header.name = 'modified.txt';
			return header;
		},
		mapStream(fileStream) {
			t.pass('should support `mapStream` and `tarTransform` options.');
			return fileStream;
		}
	}).subscribe({
		error: t.fail,
		async complete() {
			const cwd = join(tmp, '1');

			await promisifiedMkdirp(cwd);
			await extract({file: anotherDest, cwd});

			t.deepEqual(
				[...await enumerateFiles(cwd)],
				[join(cwd, 'modified.txt')],
				'should support `tarTransform` and `map` option.'
			);
		}
	});

	const fail = t.fail.bind(t, 'Unexpectedly completed.');

	fileToTar('123/456/789', '123/456/789').subscribe({
		error(err) {
			t.equal(
				err.toString(),
				`Error: Source file path must be different from the archive path. Both were specified to ${
					join(__dirname, '123', '456', '789')
				}.`,
				'should fail when the first and second paths are the same path.'
			);
		},
		complete: fail
	});

	fileToTar('none', 'dest').subscribe({
		error({code}) {
			t.equal(
				code,
				'ENOENT',
				'should fail when the source file doesn\'t exists.'
			);
		},
		complete: fail
	});

	fileToTar(tmpSymlink, 'dest').subscribe({
		error(err) {
			t.equal(
				err.toString(),
				`Error: Expected ${tmpSymlink} to be a file path, but it was a symbolic link.`,
				'should fail when the source file doesn\'t exists.'
			);
		},
		complete: fail
	});

	fileToTar(__dirname, join(tmp, '._')).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				`Error: Expected ${__dirname} to be a file path, but it was a directory.`,
				'should fail when the source is a directory.'
			);
		},
		complete: fail
	});

	fileToTar(join(__dirname, 'index.js'), join(__dirname, 'node_modules')).subscribe({
		error({code}) {
			t.equal(code, 'EISDIR', 'should fail when it cannot write a tar file.');
		},
		complete: fail
	});

	fileToTar(join(__dirname, 'index.js'), join(__filename, 'a')).subscribe({
		error({code}) {
			t.equal(code, 'EEXIST', 'should fail when it cannot create a parent directory.');
		},
		complete: fail
	});

	fileToTar(1).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: Expected a file path to be compressed as an archive, but got a non-string value 1 (number).',
				'should fail when the file path is not a string.'
			);
		},
		complete: fail
	});

	fileToTar('').subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'Error: Expected a file path to be compressed as an archive, but got \'\' (empty string).',
				'should fail when the file path is an empty string.'
			);
		},
		complete: fail
	});

	fileToTar('a', true).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: Expected a file path where an archive file will be created, but got a non-string value true (boolean).',
				'should fail when the tar path is not a string.'
			);
		},
		complete: fail
	});

	fileToTar('a', '').subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'Error: Expected a file path where an archive file will be created, but got \'\' (empty string).',
				'should fail when the tar path is an empty string.'
			);
		},
		complete: fail
	});

	fileToTar('a', 'b', /c/).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: Expected a plain object to set file-to-tar options, but got /c/ (regexp).',
				'should fail when the third argument is not a plain object.'
			);
		},
		complete: fail
	});

	fileToTar('a', 'b', {entries: 1}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'Error: file-to-tar doesn\'t support `entries` option, but 1 (number) was provided.',
				'should fail when it takes an invalid option.'
			);
		},
		complete: fail
	});

	fileToTar('a', 'b', {tarTransform: Symbol('c')}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: `tarTransform` option must be a transform stream that modifies the tar archive before writing, but got a non-stream value Symbol(c).',
				'should fail when it takes a non-stream `tarTransform` option.'
			);
		},
		complete: fail
	});

	fileToTar('a', 'b', {tarTransform: process.stdout}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: `tarTransform` option must be a transform stream that modifies ' +
        'the tar archive before writing, but got a writable stream instead.',
				'should fail when it takes an unreadable `tarTransform` option.'
			);
		},
		complete: fail
	});

	fileToTar(__filename, join(tmp, '_'), {
		mapStream() {
			return Buffer.from('a');
		}
	}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: The function passed to `mapStream` option must return a stream, but returned a non-stream value <Buffer 61>.',
				'should fail when `mapStream` function returns a non-stream value.'
			);
		},
		complete: fail
	});

	fileToTar(__filename, join(tmp, '_'), {
		mapStream() {
			return process.stdout;
		}
	}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: The function passed to `mapStream` option ' +
        'must return a stream that is readable, but returned a non-readable stream.',
				'should fail when it takes a unreadable `tarTransform` option.'
			);
		},
		complete: fail
	});
});

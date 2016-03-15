process.env['NODE_ENV'] = 'production';
process.env['PATH'] += ':' + process.env['LAMBDA_TASK_ROOT'];

var child_process = require('child_process');
var fs = require('fs');
var crypto = require('crypto');
var stream = require('stream');
var path = require('path');
var AWS = require('aws-sdk');
var async = require('async');
var config = require('./config');
var s3 = new AWS.S3();
var tempDir = process.env['TEMP'] || '/tmp';


function downloadStream(bucket, file, cb) {
	console.log('Starting download of ' + file);

	return s3.getObject({
		Bucket: bucket,
		Key: file
	}).on('error', function(res) {
		cb('S3 download error: ' + JSON.stringify(res));
	}).createReadStream();
}


function s3upload(params, filepath, cb) {
	s3.upload(params)
		.on('httpUploadProgress', function(evt) {
			console.log(filepath, 'Progress:', evt.loaded, '/', evt.total);
		})
		.send(cb);
}


function uploadFile(filepath, bucket, contentType, cb) {
	console.log('Uploading ' + filename);

	var filename = filepath.split('/').pop();
	var readStream = fs.createReadStream(filepath);

	var params = {
		Bucket: bucket,
		Key: filename,
		ContentType: contentType,
		CacheControl: 'max-age=31536000' // 1 year (60 * 60 * 24 * 365)
	};

	async.waterfall([
		function(cb) {
			console.log('Begin hashing ' + filepath);

			var hash = crypto.createHash('sha256');

			readStream.on('data', function(d) {
				hash.update(d);
			});

			readStream.on('end', function() {
				cb(null, fs.createReadStream(filepath), hash.digest('hex'));
			});
		},
		function(fstream, hashdigest, cb) {
			console.log(filename + ' hashDigest:' + hashdigest);
			params.Body = fstream;

			if (hashdigest) {
				params.Metadata = {'sha256': hashdigest};
			}

			s3upload(params, filepath, cb);
		},
		function(data, cb) {
			console.log('Uploading ' + filename + ' complete.');
		}
	], cb);
}


function ffmpegProcess(inputFile, outputName, cb) {
	console.log('Starting FFmpeg. Saving to ' + outputName);

	var opt = ['-framerate', '30', '-y', '-i', inputFile, '-c:v', 'libx264', '-vf', 'fps=30', outputName];
	child_process.execFile('ffmpeg', opt, { cwd: tempDir }, function(err, stdout, stderr) {
		console.log('FFmpeg done.');
		return cb(err, 'FFmpeg finished:' + JSON.stringify({ stdout: stdout, stderr: stderr}));
	});
}


function listObjectsInFolder(bucket, prefix, cb) {
	console.log('Listing objects in folder ' + prefix);
	var options, data = [];

	options = {
		Bucket: bucket,
		Prefix: prefix
	};

	(function doList() {
		s3.listObjects(options, function(err, partData) {
			var key;
			if (err) {
				return cb(err, data);
			}

			for (var i=0; i < partData.Contents.length; i++) {
				key = partData.Contents[i].Key;
				if (key[key.length-1] !== '/') {
					data.push(key);
				}
			}

			if (data.IsTruncated) {
				options.KeyMarker = partData.NextKeyMarker;
				options.VersionIdMarker = partData.NextVersionIdMarker;
				doList();
			} else {
				cb(null, data);
			}
		});
	}());
}


function listFoldersInBucket(bucket, prefix, cb) {
	console.log('Listing folders in bucket ' + bucket);
	var options = {
		Bucket: bucket,
		Prefix: prefix,
		Delimiter: '/',
	};

	s3.listObjects(options, function(err, data) {
		if (err) {
			return cb(err);
		}

		var folders = [];
		for (i = 0; i < data.CommonPrefixes.length; i++) {
			folders.push( data.CommonPrefixes[i].Prefix );
		}
		folders.sort();
		cb(null, folders);
	});
}

function createVideo(cb) {
	async.waterfall([
		function(cb) {
			var prefix = (new Date()).getFullYear() + '-';
			listFoldersInBucket(config.sourceBucket, prefix, function(err, data) {
				data = data || [];
				cb(err, data.pop());
			});
		},
		function(folderName, cb) {
			listObjectsInFolder(config.sourceBucket, folderName, cb);
		},
		function(files, cb) {
			var queue = files.slice(),
				saved = [];

			if (queue.length === 0) {
				return cb('No files found');
			}

			queue.sort();
			(function dlNextFile() {
				var key = queue.shift(),
					dlStream = downloadStream(config.sourceBucket, key, cb),
					ext = key.split('.').pop().toLowerCase(),
					dlFile = path.join(tempDir, 'img-' + saved.length + '.' + ext);
				saved.push(dlFile);

				dlStream.on('end', function() {
					if (queue.length > 0) {
						dlNextFile();
					} else {
						cb(null, saved);
					}
				});

				console.log('Saving download as ' + dlFile);
				dlStream.pipe(fs.createWriteStream(dlFile));
			}());
		},
		function(saved, cb) {
			var now = new Date(),
				d = [now.getFullYear(), now.getMonth()+1, now.getDate()].join('-'),
				outputName;

			outputName = path.join(tempDir, d + '_combined.' + config.format.video.extension);
			ffmpegProcess(path.join(tempDir, '%*.jpg'), outputName, function(err, data) {
				cb(err, saved, outputName);
			});
		},
		function(saved, output, cb) {
			uploadFile(output, config.destinationBucket, config.format.video.mimeType, function(err, data) {
				cb(err, saved.concat([output]));
			});
		},
		function(saved, cb) {
			(function unlinkNextFile() {
				var f = saved.shift();
				console.log('Removing ' + f);
				fs.unlink(f, function(err, data) {
					if (err) {
						return cb(err);
					}

					if (saved.length > 0) {
						return unlinkNextFile();
					}

					cb(null, 'Done!');
				});
			}());
		}
	], cb);
}


exports.handler = function(event, context) {
	createVideo(function(err, results) {
		if (err) {
			context.fail(err);
		} else {
			context.succeed(results);
		}
	});
};

var Emitter = require( 'events' )
var fs = require( 'fs' )
var path = require( 'path' )
var async = require( 'async' )
var mime = require( 'mime-types' )
var debug = require( 'debug' )( 'gh-upload' )
var octokit = require( '@octokit/rest' )()

function authenticate( credentials ) {
  return octokit.authenticate( credentials )
}

function findRelease( options, callback ) {

  getReleases( options, ( error, releases ) => {

    if( error ) {
      return callback( error )
    }

    if( releases.length > 1 ) {
      console.log( releases )
      error = new Error( `Ambiguous releases:\n${releases.map( r => `  ${r.name || r.tag } (tag: ${r.tag}, id: ${r.id})\n` )}` )
      error.code = 'ETOOMANY'
      return callback( error )
    }

    if( !releases.length ) {
      error = new Error( 'No matching releases found' )
      error.code = 'ENOENT'
      return callback( error )
    }

    var release = releases.shift()

    callback( null, release )

  })

}

function errorIsReleaseAssetAlreadyExists( error ) {
  if( error ) {
    try {
      var data = JSON.parse(error.message)
      return data &&
        Array.isArray(data.errors) &&
        data.errors.length &&
        (data.errors[0].resource === 'ReleaseAsset') &&
        (data.errors[0].code === 'already_exists') &&
        (data.errors[0].field === 'name')
    } catch( e ) {
      return false
    }
  }
}

function createRelease( options, callback ) {

  if( options.update ) {
    findRelease( options, ( error, release ) => {

      if( error && error.code === 'ENOENT' ) {
        // If the intention is to rename, but we can't find an existing release
        // with the given `options.name`, don't create a new release
        if( options.rename ) {
          error = new Error( `Couldn't find release "${options.name}" to rename` )
          error.code = 'ENOENT'
          return callback( error )
        }
        // Otherwise, set update to false and call self to create a new release
        options.update = false
        return createRelease( options, callback )
      }

      if( error ) {
        return callback( error )
      }

      octokit.repos.editRelease({
        owner: options.owner,
        repo: options.repo,
        id: release.id,
        name: options.rename || options.name,
        tag_name: options.tag,
        target_commitish: options.commit,
        draft: options.draft,
        body: options.body,
        prerelease: options.prerelease,
      }, ( error, result ) => {
        callback( error, result && result.data )
      })

    })
  } else {
    octokit.repos.createRelease({
      owner: options.owner,
      repo: options.repo,
      name: options.rename || options.name,
      tag_name: options.tag,
      target_commitish: options.commit,
      draft: options.draft,
      body: options.body,
      prerelease: options.prerelease,
    }, ( error, result ) => {
      callback( error, result && result.data )
    })
  }

}

function editRelease( options, callback ) {
  octokit.repos.getReleaseByTag({
    owner: options.owner,
    repo: options.repo,
    tag: options.tag,
  }, ( error, result ) => {

    if( error ) {
      return callback( error )
    }

    octokit.repos.editRelease({
      owner: options.owner,
      repo: options.repo,
      id: result.data.id,
      name: options.name,
      tag_name: options.tag,
      target_commitish: options.commit,
      draft: options.draft,
      body: options.body,
      prerelease: options.prerelease,
    }, ( error, result ) => {
      callback( error, result && result.data )
    })

  })
}

function deleteRelease( options, callback ) {
  octokit.repos.getReleaseByTag({
    owner: options.owner,
    repo: options.repo,
    tag: options.tag,
  }, ( error, result ) => {

    if( error ) {
      return callback( error )
    }

    octokit.repos.deleteRelease({
      owner: options.owner,
      repo: options.repo,
      id: result.data.id,
    }, callback )

  })
}

function getRelease( options, callback ) {
  octokit.repos.getReleaseByTag({
    owner: options.owner,
    repo: options.repo,
    tag: options.tag,
  }, ( error, result ) => {
    callback( error, result && result.data )
  })
}

function getReleases( options, callback ) {
  octokit.repos.getReleases({
    owner: options.owner,
    repo: options.repo,
    per_page: 100,
  }, (error, result) => {

    if( error ) {
      return callback( error )
    }

    if( options.all ) {
      return callback( null, result.data )
    }

    var releases = result.data.filter(( release ) => {

      var keep = true

      if( options.name != null )
        keep = keep && release.name == options.name
      if( options.tag != null )
        keep = keep && release.tag_name == options.tag

      if( options.draft && options.prerelease ) {
        keep = keep && (release.draft == options.draft ||
          release.prerelease == options.prerelease)
      } else if( options.draft || options.prerelease ) {
        if( options.draft )
          keep = keep && release.draft == options.draft && !release.prerelease
        if( options.prerelease )
          keep = keep && release.prerelease == options.prerelease
      } else {
        keep = keep && !(release.prerelease || release.draft)
      }

      return keep

    })

    callback( null, releases )

  })
}

function uploadAsset( filename, options, callback ) {

  var basename = path.basename( filename )
  var contentType = mime.lookup( basename ) ||
    'application/octet-stream'

  fs.stat( filename, ( error, stats ) => {

    if( error ) {
      return callback( error )
    }

    octokit.repos.uploadAsset({
      url: options.url,
      file: fs.createReadStream( filename ),
      contentType: contentType,
      contentLength: stats.size,
      name: basename,
      label: options.label,
    }, (error, result) => {
      callback( error, result )
    })

  })

}

function uploadAssets( release, assets, skip, callback ) {

  var emitter = new Emitter()

  process.nextTick(() => {
    async.mapSeries( assets, ( filename, next ) => {
      emitter.emit( 'upload', filename )
      uploadAsset( filename, { url: release.upload_url, skip: skip }, ( error, result ) => {
        if( !error ) {
          emitter.emit( 'uploaded', filename, result )
        } else if( errorIsReleaseAssetAlreadyExists(error) ) {
          emitter.emit( 'skipped', filename, error )
          error = null
        }
        next( error, result )
      })
    }, (error, results) => {
      callback( error, results )
    })
  })

  return emitter

}

module.exports = {
  createRelease: createRelease,
  editRelease: editRelease,
  getRelease: getRelease,
  deleteRelease: deleteRelease,
  getReleases: getReleases,
  uploadAsset: uploadAsset,
  uploadAssets: uploadAssets,
  authenticate: authenticate,
}

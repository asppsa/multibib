import {CSL} from 'juris-m/citeproc-js';
import URI from 'urijs';
import zip from 'zip-js';
import Kefir from 'kefir';
import localforage from 'localforage';
import pako from 'pako';

// This is a dirty hack ...
zip.useWebWorkers = false;
window.pako = pako;

// This is a simple function to display progress.
var progressEmitter;

function progress(value) {
  if (progressEmitter)
    progressEmitter.emit(value);
}

function setupProgress() {
  let progress = document.querySelector('#progress');
  var progressStream = Kefir.stream(emitter => {
    progressEmitter = emitter;
  });

  progressStream.onValue(value => {
    progress.textContent = value;
  });
}

function zoteroUri(apiKey, type, value) {
  return URI("https://api.zotero.org")
    .directory(`${type}s/${value}/items`)
    .addSearch({v: 3,
                format: 'csljson',
                key: apiKey});
}

function localeUrl(language) {
  // Make a relative URI
  let uri = new URI();
  uri.segment("locales");
  uri.segment(`locales-${language}.xml`);
  return uri.toString();
}

function flatten(arr) {
  let empty = [];
  return empty.concat.apply(empty, arr);
}

function generateDocx(zipFS, xmlFilesByPath, cites, formatted) {
  let serializer = new XMLSerializer();
  
  return Promise.all(Array.from(xmlFilesByPath).map(([path, xmlPromise]) => {
    return xmlPromise.then(xml => {
      let xmlCites = cites.filter(cite => cite.xml === xml);

      // Update the text properties ...
      for (var cite of xmlCites) {
        let instrText = cite.node
        let str = formatted.get(instrText);

        cite.json.properties.formattedCitation = str;
        cite.json.properties.plainCitation = str;

        // Write the updated JSON back into the XML
        instrText.textContent = ' ADDIN ZOTERO_ITEM CSL_CITATION '
          + JSON.stringify(cite.json);

        /* We have to carefully traverse the node tree in order
           to update the field's contents. */
        let firstR = instrText.parentElement;
        
        let seenSeparator = false;
        let textWritten = false;
        let toRemove = [];
        for (var presentR = firstR;
             presentR &&
             presentR.querySelector('fldChar[*|fldCharType="end"]') == null;
             presentR = presentR.nextElementSibling)
        {
          if (textWritten) {
            toRemove.push(presentR);
          }
          else if (seenSeparator) {
            var text;
            if (text = presentR.querySelector('t')) {
              text.textContent = str;
              textWritten = true;
            }
          }
          else {
            seenSeparator = presentR.querySelector('fldChar[*|fldCharType="separate"]');
          }

          if (!seenSeparator && presentR.localName != 'r') {
            toRemove.push(presentR);
          }
        }

        // Delete all these nodes
        toRemove.forEach(r => r.remove());
      }

      return [path, xml];
    });
  })).then(pairs => {
    // Write XML back to the zip
    pairs.forEach(([path, xml]) => {
      let [dir, name] = path.split('/');
      zipFS.remove(zipFS.find(path));
      zipFS.find(dir).addText(name, serializer.serializeToString(xml));
    });
  }).then(() => {
    return new Promise((res, rej) => {
      let exported = function (blob) {
        progress("Got blob", blob);

        try {
          // Change the mime type
          res(new Blob([blob], {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
        }
        catch (e) {
          rej(e);
        }
      };
      progress("zipping ...");
      zipFS.exportBlob(exported, function (i) { progress("Progress " + i); }, rej);
    });
  });
}

function requestFromZotero(creds, ids) {
  let [userIds, groupIds, apiKey] = creds;

  let uris = userIds.split(/\s+/).filter(id => id.length > 0).
      map(userId => zoteroUri(apiKey, 'user', userId)).
      concat(groupIds.split(/\s+/).filter(id => id.length > 0).
             map(groupId => zoteroUri(apiKey, 'group', groupId)));

  let promises = [];

  progress('fetching from zotero ...');

  // Items can be requested 50 at a time.
  for (let offset = 0;
       offset < ids.length;
       offset = offset + 50) {
    let subset = ids.slice(offset, offset + 50);
    uris.forEach(uri => {
      promises.push(fetch(uri.clone().addSearch({itemKey: subset.join(',')}).toString()));
    });
  }

  return Promise.all(promises.map(promise => {
    return promise.then(request => request.json());
  })).then(jsons => {
    return flatten(jsons.map(json => json.items));
  });
}

function processor (style) {
  let languages = ['en-GB', 'en-US']

  return Promise.all(languages.map(language => {
    return fetch(localeUrl(language))
      .then(response => response.text())
      .then(text => [language, text]);
  })).then(pairs => {
    let locales = new Map(pairs);
    return {
      engine() {
        let citations = new Map();
        let engine = new CSL.Engine({
          retrieveLocale: locales.get.bind(locales),
          retrieveItem: citations.get.bind(citations)
        }, style);

        return [engine, citations];
      },

      compile(creds, cites) {
        // Create a set of unique cite ids.
        let citeIds = new Set(flatten(cites.map(({ids: ids}) => ids)));
        return requestFromZotero(creds, Array.from(citeIds)).then(items => {

          // Create a new engine.
          let [engine, citations] = this.engine();

          // Add the items into the map.  Replace the ids with
          // shortened ones.
          items.forEach(item => {
            let id = item.id.match(/\/([^\/]*)$/)[1];
            item.id = id;
            citations.set(id, item);
          });

          // Now process each citation
          progress('appendCitationCluster ...');

          // This dodgy-as loop uses setTimeout in order to prevent
          // warnings about long-running scripts.  I'm sure this could
          // get busted somehow.
          let lastPromise = Promise.resolve(new Array(cites.length));
          for (var offset = 0;
               offset < cites.length;
               offset = offset + 20) {

            // Force a new scope
            (function (offset, total, cites) {
              lastPromise = lastPromise.then(formattedCitations => {
                return new Promise((res, rej) => {
                  setTimeout(function () {
                    try {
                      progress(`Citing ${offset}/${total} ...`);

                      for (var cite of cites) {
                        // Sometimes apparently there are bogus
                        // citation IDs.  We can ignore them provided
                        // that at least one valid ID remains.
                        let citationItems = Array.from(cite.idMap)
                            .filter(([id, item]) => citations.has(id))
                            .map(([id, item]) => ({id: id,
                                                   locator: item.locator ? item.locator : null,
                                                   label: item.label ? item.label : null}));

                        if (citationItems.length < 1) {
                          throw new Error("Failed to find anything in Zotero for citation: " + JSON.stringify(cite));
                        }

                        let cluster = {citationItems: citationItems,
                                       properties: {noteIndex: 0}};

                        engine
                          .appendCitationCluster(cluster)
                          .forEach(([k,v]) => {
                            formattedCitations[k] = v;
                          });
                      }

                      res(formattedCitations);
                    }
                    catch (e) {
                      rej(e);
                    }
                  });
                });
              });
            })(offset, cites.length, cites.slice(offset, offset + 20));
          }

          return lastPromise.then(formattedCitations => {
            // Create a map from nodes to formatted cites
            let formatted = new Map();
            for (i in formattedCitations) {
              formatted.set(cites[i].node, formattedCitations[i]);
            }

            progress('makeBibliography ...');
            let bibliography = engine.makeBibliography();

            return {formatted: formatted,
                    bibliography: bibliography};
          });
        });
      }
    };
  });
}

function processFiles(files, creds) {

  progress("processFiles ...");

  return loadCSL()
    .then(processor)
    .then(csl => {
      let parser = new DOMParser();

      progress('loading docx files ...');

      // A list of file paths, mapping to zip objects
      let zipFiles = new Map(files.map(file => {
        let zipPromise = new Promise((res, rej) => {
          let zipFS = new zip.fs.FS();
          let imported = () => res(zipFS);
          zipFS.importBlob(file, imported, rej);
        });

        return [file.name, zipPromise];
      }));

      // These are paths to look for inside the zip.
      let xmlFilePaths = ['word/document.xml', 'word/footnotes.xml'];

      progress('extracting XML ...');

      // This is a nested map of zip files to XML file names to parsed
      // XML, as a promise.
      let xmlFilesPromise = Promise
          .all(Array.from(zipFiles.values()).map(zipPromise => {
            return zipPromise.then(zipFS => {
              return Promise.all(xmlFilePaths.map(path => {
                let xmlPromise = new Promise((res, rej) => {
                  try {
                    zipFS.find(path).getText(res);
                  }
                  catch (e) {
                    rej(e);
                  }
                }).then(document => {
                  return parser.parseFromString(document, 'text/xml');
                });

                return [path, xmlPromise];
              }))
                .then(xmlPairs => [zipFS, new Map(xmlPairs)])
            });
          }))
          .then(zipPairs => new Map(zipPairs));

      // This is a list of cite objects, which record the node where
      // the citation data is, the xml file that the node belongs to,
      // and the citation itself.
      let citesPromise = xmlFilesPromise.then(zipMap => {
        return Promise.all(Array.from(zipMap.values()).map(xmlByPath => {
          return Promise.all(Array.from(xmlByPath.values()).map(xmlPromise => {
            return xmlPromise.then(xml => {
              return Array.from(xml.querySelectorAll('instrText'))
                .filter(node => node.textContent.match(/^\s*ADDIN ZOTERO_ITEM CSL_CITATION/))
                .map(node => {
                  let jsonPart = node.textContent.match(/^\s*ADDIN ZOTERO_ITEM CSL_CITATION\s*({.*})\s*$/)[1];
                  let json = JSON.parse(jsonPart);
                  let idMap = new Map(flatten(json.citationItems.map(item => item.uris.map(uri => [uri, item])))
                                      .map(([uri, item]) => {
                                        let matches = uri.match(/\/([^\/]*)$/);
                                        return matches ? [matches[1], item] : null;
                                      }).filter(pair => pair != null));

                  let ids = Array.from(idMap.keys());

                  return {ids: ids,
                          idMap: idMap,
                          node: node,
                          json: json,
                          xml: xml};
                });
            });
          })).then(citesByXmlFile => flatten(citesByXmlFile))
        })).then(citesByFile => flatten(citesByFile));
      });

      // Do the processing
      return citesPromise
        .then(cites => {
          return csl.compile(creds, cites).then(result => {
            let [obj, items] = result.bibliography;
            return {
              zipFiles: zipFiles,
              bibliography: obj.bibstart + items.join('') + obj.bibend,
              cites: cites,
              formatted: result.formatted,
              generateDocx(name) {
                return this.zipFiles.get(name).then(zipFS => {
                  return xmlFilesPromise.then(zipMap => {
                    let xmlFilesByPath = zipMap.get(zipFS);
                    
                    return generateDocx(zipFS, xmlFilesByPath, this.cites, this.formatted);
                  })
                });
              }
            };
          })
        });
    });
}

function loadZoteroCredentials() {
  return localforage.getItem('zoteroCredentials').then(creds => {
    return creds
      ? creds
      : [null, null, null];
  });
}

function saveZoteroCredentials(creds) {
  return localforage.setItem('zoteroCredentials', creds);
}

function loadCSL() {
  return localforage.getItem('csl');
}

function saveCSL(csl) {
  return localforage.setItem('csl', csl);
}

function initApplication() {
  let bibliography = document.querySelector('#bibliography');
  let filesInput = document.querySelector('#docx-files');
  
  let go = document.querySelector('#go');

  let userIdsInput = document.querySelector('#user-ids');
  let groupIdsInput = document.querySelector('#group-ids');
  let apiKeyInput = document.querySelector('#api-key');
  let saveButton = document.querySelector('#save-zotero');

  let cslStatus = document.querySelector('#csl-status');
  let cslFileInput = document.querySelector('#csl-file');
  let cslURLInput = document.querySelector('#csl-url');
  let cslInputRadios = document.forms['style-file'].elements['csl'];
  let cslGetButton = document.querySelector('#get-csl');

  Promise.all([
    loadCSL()
      .then(csl => {
        let cslFileStream = Kefir
            .fromEvents(cslFileInput, 'change', ev => ev.target.files[0])
            .toProperty(() => cslFileInput.files[0]);

        let cslURLStream = Kefir
            .fromEvents(cslURLInput, 'input', ev => ev.target.value)
            .toProperty(() => cslURLInput.value);

        let cslInputStream = Kefir
            .merge(Array.from(cslInputRadios)
                   .map(input => Kefir.fromEvents(input, 'change')))
            .map(() => cslInputRadios.value)
            .toProperty(() => cslInputRadios.value);

        let cslSourceStream = Kefir
            .combine([cslFileStream,
                      cslURLStream,
                      cslInputStream],
                     (file, url, input) => {
                       if (input == 'file') {
                         return file;
                       }
                       else if (input == 'url' && url.length > 0) {
                         return url;
                       }
                       else {
                         return null;
                       }
                     })
            .toProperty();

        let cslGetStream = Kefir.
            fromEvents(cslGetButton, 'click');

        let cslNewStream = cslSourceStream
            .sampledBy(cslGetStream)
            .flatMapFirst(thing => {
              if (thing instanceof File) {
                return Kefir.fromPromise(new Promise((res, rej) => {
                  let reader = new FileReader();

                  reader.onload = function () {
                    res(reader.result);
                  };
                  reader.onerror = rej;

                  reader.readAsText(thing);
                }));
              }
              else if (thing) {
                progress('Fetching ' + thing);
                return Kefir.fromPromise(fetch(thing).then(result => result.text()));
              }
              else {
                return Kefir.constantError('no input');
              }
            });

        let cslSavedStream = cslNewStream
            .ignoreErrors()
            .flatMapFirst(csl => Kefir.fromPromise(saveCSL(csl)));

        cslSavedStream.onValue(csl => {
          progress('saved CSL');
        });

        let cslStream = cslSavedStream
            .toProperty(() => csl);

        let cslStatusStream = cslStream.map(csl => {
          if (csl) {
            try {
              let parser = new DOMParser();
              let xml = parser.parseFromString(csl, 'text/xml');
              let title = xml.querySelector('info > title');
              return "Using " + title.textContent;
            }
            catch (e) {
              return "File has been uploaded but is not valid CSL";
            }
          }
          else {
            return "No CSL file";
          }
        });

        cslStatusStream.onValue(status => {
          cslStatus.textContent = status;
        });

        return cslStream;
      }),
    loadZoteroCredentials()
      .then(([userIds, groupIds, apiKey]) => {
        userIdsInput.value = userIds;
        let userIdsStream = Kefir
            .fromEvents(userIdsInput, 'input', ev => ev.target.value)
            .toProperty(() => userIdsInput.value);

        groupIdsInput.value = groupIds;
        let groupIdsStream = Kefir
            .fromEvents(groupIdsInput, 'input', ev => ev.target.value)
            .toProperty(() => groupIdsInput.value);

        apiKeyInput.value = apiKey;
        let apiKeyStream = Kefir
            .fromEvents(apiKeyInput, 'input', ev => ev.target.value)
            .toProperty(() => apiKeyInput.value);

        let saveClickStream = Kefir.fromEvents(saveButton, 'click');

        let credentialStream = Kefir
            .combine([userIdsStream,
                      groupIdsStream,
                      apiKeyStream])
            .toProperty();

        let saveCredentialStream = credentialStream
            .sampledBy(saveClickStream);

        let completedSaveStream = saveCredentialStream
            .flatMapFirst(credentials => {
              return Kefir.fromPromise(saveZoteroCredentials(credentials));
            });

        completedSaveStream.onAny(saved => {
          progress('saved');
        });

        // Whenever a save begins, we disable the button.  Whenever a
        // save completes or fails, we re-enable the button.
        let saveDisabled = Kefir
            .merge([saveCredentialStream.map(() => true),
                    completedSaveStream.map(() => false)])
            .toProperty(() => false);

        saveDisabled.onValue(disabled => {
          saveButton.disabled = disabled;
        });

        return credentialStream;
      })
  ]).then(([cslStream, credentialStream]) => {
    // This streams clicks to the go button
    let goStream = Kefir.fromEvents(go, 'click');

    // This represents the currently selected file set.
    let filesStream = Kefir
        .fromEvents(filesInput, 'change', ev => ev.target.files)
        .toProperty(() => filesInput.files)
        .map(fileList => Array.from(fileList));

    // Returns the result of processing when 'go' is clicked.
    let processedFilesStream = Kefir
        .combine([filesStream, credentialStream])
        .sampledBy(goStream)
        .flatMapFirst(([files, creds]) => {
          return Kefir.fromPromise(processFiles(files, creds));
        });

    processedFilesStream.onError(e => {
      console.error(e);
      progress("Error: " + e);
    });

    // Whenever processing begins, we disable the button.  Whenever
    // processing completes or fails, we re-enable the button.
    let haveDetailsStream = Kefir
        .combine([filesStream, credentialStream, cslStream],
                 (files, credentials, csl) => {
                   return files.length > 0 &&
                     csl &&
                     credentials.every(cred => cred && cred.length > 0);
                 })
        .toProperty();

    let goDisabled = Kefir
        .merge([goStream.map(() => true),
                processedFilesStream.map(() => false)])
        .toProperty(() => false)
        .combine(haveDetailsStream, (goDisabled, haveDetails) => {
          return goDisabled || !haveDetails;
        });

    goDisabled.onValue(disabled => {
      go.disabled = disabled;
    });

    // This is used to display the results.  Whenever "go" is
    // clicked, we blank out the bib.
    let bibliographyStream = Kefir
        .merge([goStream.map(() => ''),
                processedFilesStream.map(result => result.bibliography)])
        .toProperty(() => '');

    // Display the bibliography
    bibliographyStream.onValue(bib => {
      bibliography.innerHTML = '<h3>Bibliography</h3>' + bib;
    });

    return processedFilesStream;
  })
    .then(processedFilesStream => {
      let links = document.querySelector('#links');

      // This is a stream of lists of files to display.
      let fileListStream = processedFilesStream.map(result => {
        return Array
          .from(result.zipFiles.keys())
          .map(name => {
            return {
              name: name,
              generateDocx() {
                return result.generateDocx(this.name);
              }
            };
          });
      });

      // This is a stream of lists of elements that display the docx
      // files.
      let elementListStream = fileListStream.map(files => {
        return files.map(file => {
          let elt = document.createElement('li');
          elt.innerHTML = `
            <div class="name"></div>
            <div>
              <button class="generate">Generate DOCX</button>
            </div>
            <div class="download"></div>`;

          elt.querySelector('.name').textContent = file.name;
          let generateButton = elt.querySelector('button.generate');
          let downloadArea = elt.querySelector('.download');

          let generateClickStream = Kefir.fromEvents(generateButton, 'click');

          // Only ever generate the docx once.
          let docxStream = generateClickStream
              .take(1)
              .flatMapFirst(() => {
                progress('generating ...');
                return Kefir.fromPromise(file.generateDocx());
              });

          docxStream
            .map(blob => URL.createObjectURL(blob))
            .onValue(url => {
              let a = document.createElement('a');
              a.setAttribute('href', url);
              a.setAttribute('download', file.name);
              a.textContent = 'Download';
              downloadArea.appendChild(a);
            });

          docxStream.onError(e => {
            console.error(e);
            progress("Error: " + e);
          });

          return elt;
        });
      });

      elementListStream.slidingWindow(2).onValue(eltSets => {
        // Remove any old elements.
        if (eltSets.length > 1) {
          let oldElts = flatten(eltSets.slice(0, eltSets.length - 1));
          oldElts.forEach(elt => {
            var a;
            if (a = elt.querySelector('a[href]'))
              URL.revokeObjectURL(a.getAttribute('href'));
            elt.remove();
          });
        }

        // Add the new elements.
        elts = eltSets[eltSets.length - 1];
        elts.forEach(elt => links.appendChild(elt));
      });
    });
}

if (document.readyState == "interactive") {
  setupProgress();
  initApplication();
}
else {
  document.addEventListener('readystatechange', (ev) => {
    if (document.readyState == "interactive")
      initApplication();
  });
}

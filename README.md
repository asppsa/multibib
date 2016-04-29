# Zotero Multibib

So, we had a problem with an extremely large document authored in
Word.  Having the whole document in a single file was causing Word to
crash, so we were keeping it in lots of separate smaller docs.  This
was fine, except that we were using Zotero to do citations, so we
didn't have a way to get a complete bibliography, and to get the right
disambiguation ("Pharo 2016a", etc.) in the text.

I wrote this tool to fix this problem.  Basically it's a web app that
you can upload your DOCX files into.  It will then do two things with
them:

1. generate an HTML version of the bibliography which you can
   cut-paste back into your document; and

2. provide links to modified versions of each DOCX file with the
   citations amended to be consistent with the bibliography.

It uses quite a few assumptions.  At least these ones might be of
note.

1. assumes you are only using DOCX.  I'm sure ODT support could be
   added, but we didn't need it, so it hasn't been done.

2. assumes that only English locales are needed.  Again, this can
   easily be improved on.

Here's hoping this is useful to others!


## How to run

The app is just a static web page.  You can run it by building the app
(see below), then launching a web server, and getting it to
serve the "public" folder in this repo.

It requires quite a few modern browser features.  You will probably
want to use Firefox or Chrome.


## Building

The code was written using JSPM with Babel, but we're bundling to get
the startup time down a bit.  You can build the bundle using gulp:

~~~
npm install
gulp
~~~


## Licence

Apache 2.0 licence.

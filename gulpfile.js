var gulp = require('gulp'),
    gulp_jspm = require('gulp-jspm'),
    plumber = require('gulp-plumber');

gulp.task('main', function () {
  return gulp.src('public/lib/main.js')
    .pipe(plumber())
    .pipe(gulp_jspm())
    .pipe(gulp.dest('public/'));
});

gulp.task('watch', function () {
  gulp.watch('public/lib/main.js', ['main']);
});

gulp.task('default', ['watch', 'main']);

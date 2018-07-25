
/* 
	search.js: Search page routes and all search engine functionality including indexing and querying
*/

var porterStemmer = require('./porterstemmer.js');
var chunk = require('lodash.chunk');
var auth = require('./auth.js');
var con = require('./database.js').connection;
var settings = require('./settings.js').search;

module.exports = {

	// set up routes
	init: function(app) {

		// post search query, render results
		app.post('/search', function(req, res) {

			// generate SQL to filter by category and answer status
			var catFilter = module.exports.categoryFilter(req.body.category);
			var ansFilter = module.exports.answerFilter(req.body.answeredStatus);

			// get default render object and add query to template
			var render = auth.defaultRender(req);
			render.query = req.body.query;

			// parse page number
			var page = parseInt(req.body.page, 10);
			if (isNaN(page) || page < 1) page = 1;

			// add page info to render object
			render.page = page;

			// calculate starting index for retrieving posts for this page
			var startIndex = (page - 1) * settings.resultsPerPage;

			// pull question categories for rendering search filters
			con.query('SELECT * FROM categories;', function(err, categories) {
				if (!err && categories !== undefined && categories.length > 0) {
					render.categories = categories;

					// register which category filter was last applied (if any)
					for (var i = 0; i < categories.length; i++) {
						if (categories[i].uid == req.body.category) {
							categories[i].isSelected = true;
							break;
						}
					}
				}

				render[req.body.answeredStatus] = true;	// register which answer filter was used

				var userConstraint, query;

				// check query for user constraint ("user:uid"), and extract if found
				module.exports.parseUserConstraint(req.body.query, function(data) {
					query = data.query;
					userConstraint = data.userConstraint;

					// search by query if possible
					if (query) {
						// parse query into correct format
						query = module.exports.parseQuery(query);

						// get relevant posts
						con.query('CALL query(?, ?, ?, ?, ?);', [query, catFilter, ansFilter, userConstraint, settings.maxNumResults], function(err, rows) {
							if (!err && rows !== undefined && rows.length > 0 && rows[0].length > 0) {
								// prepare page render object
								module.exports.prepRender(render, rows[0], startIndex, settings.resultsPerPage);
							}

							res.render('search.html', render);
						});

					// search only by constraints if they exist
					} else {
						// get posts meeting constraints
						con.query('CALL noquery(?, ?, ?, ?);', [catFilter, ansFilter, userConstraint, settings.maxNumResults], function(err, rows) {
							if (!err && rows !== undefined && rows.length > 0 && rows[0].length > 0) {
								// prepare page render object
								module.exports.prepRender(render, rows[0], startIndex, settings.resultsPerPage);
							}

							res.render('search.html', render);	
						});
					}

				});
			});
		});

		// render search page with recent questions
		app.get('/search', function(req, res) {
			var render = auth.defaultRender(req);

			render.page = 1;	// default to first page of results

			// get categories for filters
			con.query('SELECT * FROM categories;', function(err, categories) {
				if (!err && categories !== undefined && categories.length > 0) {
					render.categories = categories;
				}

				// get recent posts (just call noquery with no constraints)
				con.query('CALL noquery("", "", "", ?);', [settings.maxNumResults], function(err, rows) {
					if (!err && rows !== undefined && rows.length > 0 && rows[0].length > 0) {
						// prepare page render object
						module.exports.prepRender(render, rows[0], 0, settings.resultsPerPage);
					}

					res.render('search.html', render);
				});
			});
		});

		return module.exports;
	},

	// calculate page info and extract single page of search results
	prepRender: function(render, fullResults, start, perPage) {
		// calculate number of pages for full results
		var totalPages = Math.ceil(fullResults.length / perPage);

		// generate array of possible pages for this search
		render.pages = Array.apply(null, {length: totalPages + 1}).map(Function.call, Number);
		render.pages.shift();

		// get references to previous and following page numbers
		if (render.page < render.pages.length) render.nextPage = render.page + 1;
		if (render.page - 1 > 0) render.prevPage = render.page - 1;

		// extract single page
		render.results = fullResults.slice(start, start + perPage);

		// send count of results showing on this page
		render.onThisPage = render.results.length;

		// register that results exist if any found
		if (render.results.length > 0) render.hasResults = true;
	},

	// make post accessible to search engine by scoring its relevance to the terms it contains
	indexPost: function(uid, title, body) {
		var re = new RegExp(/[^a-zA-Z ]/, 'g');
		var words = (title + '\n' + body).toLowerCase().split(/\s/);	// concatenate title and body into one long post string, split into terms
		var stems = [], scores = {}, max;

		// for each term in post
		for (var i = 0; i < words.length; i++) {
			words[i] = words[i].replace(re, '');	// strip punctuation

			// if relevant, add stem
			if (!module.exports.isStopWord(words[i])) {
				// stem word
				var stem = porterStemmer.stem(words[i]);

				// if stem not yet seen
				if (!scores[stem]) {
					scores[stem] = 0;	// default score
					stems.push(stem);	// add to list of all stems
				}

				// increment stem frequency
				scores[stem]++;

				// update maximum frequency
				if (!max || scores[stem] > max) {
					max = scores[stem];
				}
			}
		}

		// record stems in db, ignore duplicates
		con.query('INSERT IGNORE INTO stems (stem) VALUES ?;', [chunk(stems, 1)], function(err, rows) {
			if (!err) {
				// get uid's
				con.query('SELECT uid, stem FROM stems WHERE FIND_IN_SET(stem, ?);', [stems.join(',')], function(err, rows) {
					if (!err && rows !== undefined && rows.length > 0) {
						// finalize scores (divide by max frequency in post)
						var insertScores = [];
						for (var i = 0; i < rows.length; i++) {
							insertScores.push([rows[i].uid, uid, scores[rows[i].stem] / max]);
						}

						// insert scores
						con.query('INSERT INTO scores (stem_uid, post_uid, score) VALUES ?;', [insertScores], function(err, rows) {});
					}
				});
			}
		});
	},

	// given free text query, strip of stop words, etc, and format for SQL query
	parseQuery: function(q) {
		// regex to match non-alphabetic and non-space chars
		var re = /[^a-zA-Z ]/g;
		var query = [];

		var words = q.replace(re, '');	// strip of non-alphabetic punctuation / symbols
		words = words.toLowerCase().split(" ");	// bring to lower case and split into words

		// filter out stop words, stem query terms
		for (var i = 0; i < words.length; i++) {
			if (!module.exports.isStopWord(words[i])) {
				query.push('"' + porterStemmer.stem(words[i]) + '"');
			}
		}

		// join into acceptable SQL format by concatenating together with commas
		return query.join(',');
	},

	// given free text query, extract user constraint ("user:uid") if exists, and strip query of this constraint
	parseUserConstraint: function(q, callback) {
		var userRe = /user:([0-9]+)/g;	// regex to match user constraint syntax
		var userConstraint;

		var userUID = userRe.exec(q);	// check for user constraint in query
		if (q) q = q.replace(userRe, '');	// strip query of user constraint text

		// if user constraint was found
		if (userUID) {
			userUID = userUID[1];	// get the first group of the match, just the uid

			// check if user exists
			con.query('SELECT COUNT(*) AS count FROM users WHERE uid = ?;', [userUID], function(err, rows) {
				// if legitimate user, format mysql query constraint
				if (!err && rows !== undefined && rows.length > 0 && rows[0].count == 1) {
					userConstraint = " AND q.owner_uid = " + userUID;
				} else {
					userConstraint = "";
				}

				// return formatted query and formatted user constraint
				callback({
					query: q,
					userConstraint: userConstraint
				});
			});
		} else {
			// apply no user constraint
			callback({
				query: q,
				userConstraint: ""
			});
		}
	},

	// generate SQL to apply answer status constraint (see query and noquery functions in create_db.sql)
	answerFilter: function(status) {
		if (status == "Unanswered") {
			return " AND q.answer_count = 0";
		} else if (status == "Answered") {
			return " AND q.answer_count > 0";
		} else {
			return "";
		}
	},

	// generate SQL to apply category constraint (see query and noquery functions in create_db.sql)
	categoryFilter: function(uid) {
		uid = parseInt(uid, 10);

		// if no uid default to no constraint
		if (!uid || uid == 0) {
			return "";
		} else {
			return " AND q.category_uid = " + uid;
		}
	},

	// determine if word is irrelevant
	// (from https://gist.github.com/sebleier/554280)
	isStopWord: function(w) {
		return ["", "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your", "yours", "yourself", "yourselves", "he", "him", "his", "himself", "she", "her", "hers", "herself", "it", "its", "itself", "they", "them", "their", "theirs", "themselves", "what", "which", "who", "whom", "this", "that", "these", "those", "am", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an", "the", "and", "but", "if", "or", "because", "as", "until", "while", "of", "at", "by", "for", "with", "about", "against", "between", "into", "through", "during", "before", "after", "above", "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "s", "t", "can", "will", "just", "don", "should", "now"].indexOf(w) != -1;
	}
}
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Note = require('./models/Note');
const { ensureAuthenticated, isAdmin, isOwnerOrAdmin } = require('./middlewares/auth');
const app = express();
const PORT = process.env.PORT || 3000;
const methodOverride = require('method-override');

app.use(methodOverride('_method'));

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.log(err));

// Middleware to parse incoming requests
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Set static folder for public assets
app.use(express.static(path.join(__dirname, 'public')));

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session middleware (using MongoDB to store sessions)
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

// Multer setup for file uploads (profile pictures)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    // Prepend Date.now() to make filename unique
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Import the User model
const User = require('./models/User');

// Home route
app.get('/', (req, res) => {
  res.render('index', { user: req.session.user });
});

// Registration form
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});


// GET /users/profile - Retrieve logged-in user's profile
app.get('/users/profile', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    res.render('profile', { user, error: null });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

// PUT /users/profile - Allow users to update their profile
app.post('/users/profile', ensureAuthenticated, upload.single('profilePic'), async (req, res) => {
  const { username, email, currentPassword, newPassword, confirmNewPassword } = req.body;
  let profilePicPath = req.file ? '/uploads/' + req.file.filename : req.session.user.profilePic;

  if (!username || !email) {
      return res.render('profile', { user: req.session.user, error: 'Username and email are required.' });
  }

  try {
      const user = await User.findById(req.session.userId);

      // Update basic details
      user.username = username;
      user.email = email;
      user.profilePic = profilePicPath;

      // Handle password change if new password is provided
      if (newPassword || confirmNewPassword) {
          if (!currentPassword) {
              return res.render('profile', { user, error: 'Current password is required to change your password.' });
          }
          
          const isMatch = await bcrypt.compare(currentPassword, user.password);
          if (!isMatch) {
              return res.render('profile', { user, error: 'Incorrect current password.' });
          }

          if (newPassword !== confirmNewPassword) {
              return res.render('profile', { user, error: 'New passwords do not match.' });
          }

          const salt = await bcrypt.genSalt(10);
          user.password = await bcrypt.hash(newPassword, salt);
      }

      await user.save();

      // Update session data
      req.session.user.username = user.username;
      req.session.user.email = user.email;
      req.session.user.profilePic = user.profilePic;

      res.render('profile', { user, success: 'Profile updated successfully!' });
  } catch (err) {
      console.error(err);
      res.render('profile', { user: req.session.user, error: 'Update failed. Try again.' });
  }
});


// Handle registration
app.post('/register', upload.single('profilePic'), async (req, res) => {
  const { username, email, password, confirmPassword, role } = req.body;
  let profilePicPath = req.file ? '/uploads/' + req.file.filename : '';

  // Validate input fields
  if (!username || !email || !password || !confirmPassword) {
    return res.render('register', { error: 'Please fill in all fields.' });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'Passwords do not match.' });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password must be at least 6 characters.' });
  }

  try {
    // Check if the email is already registered
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.render('register', { error: 'Email is already registered.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Assign role securely: Only allow 'user' and 'admin' roles
    let userRole = 'user'; // Default role
    if (role === 'admin') {
      // Check if an admin is creating this user (Prevent normal users from setting admin role)
      const adminUser = await User.findOne({ role: 'admin' });
      if (!adminUser) {
        userRole = 'admin'; // First registered user becomes admin
      }
    }

    // Create new user
    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      profilePic: profilePicPath,
      role: userRole,
    });

    await newUser.save();
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'Something went wrong. Please try again.' });
  }
});


// Login form
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Handle login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    // Check if account is locked due to failed login attempts
    if (user.isLocked) {
      return res.render('login', { error: 'Account is locked due to multiple failed login attempts.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      // Increment failed login attempts
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= 5) {
        user.isLocked = true;
      }
      await user.save();
      return res.render('login', { error: 'Invalid email or password.' });
    }

    // Reset failed attempts on successful login
    user.failedLoginAttempts = 0;
    user.isLocked = false;
    await user.save();

    // Save user data in session
    req.session.userId = user._id;
    req.session.user = {
      id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      profilePic: user.profilePic
    };

    console.log("User logged in:", req.session.user); // Debugging log

    // Redirect based on user role
    if (user.role === 'admin') {
      return res.redirect('/admin/notes');
    } else {
      return res.redirect('/dashboard');
    }
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Please try again.' });
  }
});


// Dashboard (Protected Route)
app.get('/dashboard', ensureAuthenticated, (req, res) => {
  res.render('dashboard', { user: req.session.user });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Example of a CRUD operation route 
app.get('/edit-profile', ensureAuthenticated, async (req, res) => {
  const user = await User.findById(req.session.userId);
  res.render('edit-profile', { user, error: null });
});

app.post('/edit-profile', ensureAuthenticated, upload.single('profilePic'), async (req, res) => {
  const { username, email } = req.body;
  let profilePicPath = req.file ? '/uploads/' + req.file.filename : req.session.user.profilePic;
  
  if (!username || !email) {
    return res.render('edit-profile', { user: req.session.user, error: 'All fields are required.' });
  }
  
  try {
    const updatedUser = await User.findByIdAndUpdate(req.session.userId, { username, email, profilePic: profilePicPath }, { new: true });
    // Update session info
    req.session.user.username = updatedUser.username;
    req.session.user.email = updatedUser.email;
    req.session.user.profilePic = updatedUser.profilePic;
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('edit-profile', { user: req.session.user, error: 'Update failed. Try again.' });
  }
});
// GET: Fetch notes for logged-in users
app.get('/notes', ensureAuthenticated, async (req, res) => {
  try {
      const notes = await Note.find({ userId: req.session.userId });
      res.render('notes/index', { user: req.session.user, notes });
  } catch (err) {
      console.error(err);
      res.send("Error fetching notes");
  }
});

// CREATE: Show form for creating a new note
app.get('/notes/new', ensureAuthenticated, (req, res) => {
  res.render('notes/new', { user: req.session.user, error: null });
});

// CREATE: Handle note creation
app.post('/notes', ensureAuthenticated, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
      return res.render('notes/new', { user: req.session.user, error: 'Title and content are required' });
  }
  try {
      const note = new Note({
          title,
          content,
          userId: req.session.userId
      });
      await note.save();
      res.redirect('/notes');
  } catch (err) {
      console.error(err);
      res.render('notes/new', { user: req.session.user, error: 'Error creating note' });
  }
});

// UPDATE: Show edit form
app.get('/notes/:id/edit', ensureAuthenticated, async (req, res) => {
  try {
      const note = await Note.findOne({ _id: req.params.id, userId: req.session.userId });
      if (!note) {
          return res.redirect('/notes');
      }
      res.render('notes/edit', { user: req.session.user, note, error: null });
  } catch (err) {
      console.error(err);
      res.redirect('/notes');
  }
});

// UPDATE: Handle note updates
app.post('/notes/:id/edit', ensureAuthenticated, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
      return res.render('notes/edit', { 
          user: req.session.user, 
          note: { _id: req.params.id, title, content },
          error: 'Title and content are required' 
      });
  }
  try {
      await Note.findOneAndUpdate(
          { _id: req.params.id, userId: req.session.userId },
          { title, content }
      );
      res.redirect('/notes');
  } catch (err) {
      console.error(err);
      res.render('notes/edit', { 
          user: req.session.user, 
          note: { _id: req.params.id, title, content },
          error: 'Error updating note' 
      });
  }
});

// DELETE: Allow users to delete their own notes
app.delete('/notes/:id', ensureAuthenticated, async (req, res) => {
  try {
      const deletedNote = await Note.findOneAndDelete({ _id: req.params.id, userId: req.session.userId });

      if (!deletedNote) {
          return res.status(404).json({ success: false, message: "Note not found or you don't have permission" });
      }

      res.json({ success: true, message: 'Note deleted successfully' });
  } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Error deleting note' });
  }
});

// GET: Admin Panel - Fetch all notes
app.get('/admin/notes', ensureAuthenticated, isAdmin, async (req, res) => {
  try {
      const { userId, search } = req.query;

      let filter = {};
      if (userId) filter.userId = userId;
      if (search) filter.title = { $regex: search, $options: 'i' }; // Case-insensitive search

      const notes = await Note.find(filter)
          .populate('userId', 'username')
          .sort({ createdAt: -1 });

      const users = await User.find({}, '_id username'); // Fetch users for dropdown filter

      res.render('admin_notes', { notes, users, user: req.session.user });
  } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
  }
});


// DELETE: Admin deletes any note
app.delete('/admin/delete-note/:id', ensureAuthenticated, isAdmin, async (req, res) => {
  try {
      await Note.findByIdAndDelete(req.params.id);
      res.json({ success: true, message: 'Note deleted successfully' });
  } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, message: 'Error deleting note' });
  }
});


app.get('/admin/top-authors', ensureAuthenticated, isAdmin, async (req, res) => {
  try {
      const topAuthors = await Note.aggregate([
          {
              $group: {
                  _id: "$userId",
                  postCount: { $sum: 1 }
              }
          },
          {
              $lookup: {
                  from: "users",
                  localField: "_id",
                  foreignField: "_id",
                  as: "user"
              }
          },
          {
              $unwind: "$user"
          },
          {
              $project: {
                  _id: 0,
                  username: "$user.username",
                  postCount: 1
              }
          },
          {
              $sort: { postCount: -1 }
          },
          {
              $limit: 10 // Get top 10 authors
          }
      ]);

      res.render('admin_top_authors', { 
          topAuthors, 
          user: req.session.user // Pass user to EJS template
      });
  } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching top authors");
  }
});


// -----------------------
// Start the Server
// -----------------------
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
